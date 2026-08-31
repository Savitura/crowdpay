const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const { startKycForUser } = require('../services/kycService');
const { listCreatorCampaigns, listUserContributions } = require('../services/userDashboardService');
const { listFollowedCampaigns } = require('../services/campaignFollowService');
const { evaluateBadges, getLeaderboard } = require('../services/badgeService');
const { ensureCustodialAccountFundedAndTrusted } = require('../services/stellarService');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const { sendWalletFundingFailedEmail } = require('../services/emailService');
const asyncHandler = require('../utils/asyncHandler');

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, wallet_public_key, wallet_type, role, kyc_status, kyc_completed_at, wallet_funded_at, wallet_funding_failed_at, created_at,
            verification_status, verification_tier, persona_inquiry_id
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({
    ...rows[0],
    kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    impersonation: req.impersonation
      ? {
          active: true,
          admin_user_id: req.impersonation.adminUserId,
        }
      : null,
    impersonated_by: req.impersonation?.adminUserId || null,
  });
}));

async function handleRetryWalletFunding(req, res) {
  const targetUserId = (req.user.role === 'admin' && req.body?.userId)
    ? req.body.userId
    : req.user.userId;

  const { rows } = await db.query(
    'SELECT id, email, name, wallet_public_key, wallet_secret_encrypted, wallet_type, wallet_funded_at, wallet_funding_failed_at FROM users WHERE id = $1',
    [targetUserId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = rows[0];

  if (user.wallet_type !== 'custodial') {
    return res.status(400).json({ error: 'Non-custodial (freighter) wallets do not require background funding' });
  }

  if (!user.wallet_secret_encrypted) {
    return res.status(400).json({ error: 'No wallet secret found for user' });
  }

  let decryptedSecret = null;
  try {
    await withDecryptedWalletSecret(
      user.wallet_secret_encrypted,
      { userId: user.id, walletPublicKey: user.wallet_public_key },
      async (secret) => {
        decryptedSecret = secret;
      }
    );
  } catch (err) {
    return res.status(500).json({ error: 'Failed to decrypt wallet secret', details: err.message });
  }

  try {
    await ensureCustodialAccountFundedAndTrusted({
      publicKey: user.wallet_public_key,
      secret: decryptedSecret,
    });

    await db.query(
      'UPDATE users SET wallet_funded_at = NOW(), wallet_funding_failed_at = NULL WHERE id = $1',
      [user.id]
    );

    res.json({
      message: 'Wallet funding and trustlines established successfully',
      funded: true,
      user_id: user.id,
      wallet_public_key: user.wallet_public_key,
    });
  } catch (err) {
    logger.error('Retry wallet funding failed', { userId: user.id, error: err.message });

    await db.query(
      'UPDATE users SET wallet_funding_failed_at = NOW() WHERE id = $1',
      [user.id]
    );

    sendWalletFundingFailedEmail({
      to: user.email,
      name: user.name,
      walletPublicKey: user.wallet_public_key,
    }).catch((emailErr) => {
      logger.error('Failed to send wallet funding failed email on retry', {
        userId: user.id,
        error: emailErr.message,
      });
    });

    res.status(502).json({
      error: 'Wallet funding failed. Please check platform funds or try adding funds manually.',
      details: err.message,
    });
  }
}

router.post('/retry-wallet-funding', requireAuth, asyncHandler(handleRetryWalletFunding));
router.post('/me/retry-wallet-funding', requireAuth, asyncHandler(handleRetryWalletFunding));

router.post('/me/kyc/start', requireAuth, asyncHandler(async (req, res) => {
  try {
    const result = await startKycForUser(req.user.userId);
    if (result.status === 'verified') {
      return res.json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(502).json({ error: err.message || 'Could not start identity verification' });
  }
}));

router.get('/me/campaigns', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listCreatorCampaigns(req.user.userId);
  res.json(campaigns);
}));

router.get('/me/stats', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT
      COUNT(*)::int AS total_campaigns,
      COALESCE(SUM(raised_amount), 0)::numeric AS total_raised,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
      COUNT(*) FILTER (WHERE status = 'funded')::int AS funded_campaigns,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_campaigns,
      COUNT(*) FILTER (WHERE status IN ('completed', 'closed', 'withdrawn', 'failed'))::int AS closed_campaigns
     FROM campaigns
     WHERE creator_id = $1`,
    [req.user.userId]
  );
  res.json(rows[0]);
}));

const { getCampaignBalance } = require('../services/stellarService');

router.get('/me/balance', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json({ balance, public_key: rows[0].wallet_public_key });
}));

router.get('/me/contributions', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return res.status(404).json({ error: 'User not found' });
  res.json(rows);
}));

router.get('/me/favorites', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
            c.asset_type, c.status, c.deadline, cf.created_at AS favorited_at
     FROM contributor_favorites cf
     JOIN campaigns c ON c.id = cf.campaign_id
     WHERE cf.user_id = $1
     ORDER BY cf.created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
}));

// Public contributor leaderboard (#597). Declared before /me routes so the
// literal path is not shadowed by a parameterised one.
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const leaderboard = await getLeaderboard({ limit: req.query.limit });
  res.json(leaderboard);
}));

router.get('/me/badges', requireAuth, asyncHandler(async (req, res) => {
  const badges = await evaluateBadges(req.user.userId);
  res.json(badges);
}));

router.get('/me/following', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listFollowedCampaigns(req.user.userId);
  res.json(campaigns);
}));

router.get('/me/notification-preferences', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT campaign_updates, refunds, disputes, milestones, marketing FROM notification_preferences WHERE user_id = $1',
    [req.user.userId]
  );
  if (rows.length > 0) {
    res.json(rows[0]);
  } else {
    res.json({
      campaign_updates: true,
      refunds: true,
      disputes: true,
      milestones: true,
      marketing: false,
    });
  }
}));

router.patch('/me/notification-preferences', requireAuth, asyncHandler(async (req, res) => {
  const { campaign_updates, refunds, disputes, milestones, marketing } = req.body;
    const toNull = v => v === undefined ? null : v;
  const { rows } = await db.query(
    `INSERT INTO notification_preferences (user_id, campaign_updates, refunds, disputes, milestones, marketing)
     VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), COALESCE($4, TRUE), COALESCE($5, TRUE), COALESCE($6, FALSE))
     ON CONFLICT (user_id) DO UPDATE SET
       campaign_updates = COALESCE($2, notification_preferences.campaign_updates),
       refunds = COALESCE($3, notification_preferences.refunds),
       disputes = COALESCE($4, notification_preferences.disputes),
       milestones = COALESCE($5, notification_preferences.milestones),
       marketing = COALESCE($6, notification_preferences.marketing),
       updated_at = NOW()
     RETURNING campaign_updates, refunds, disputes, milestones, marketing`,
    [req.user.userId, toNull(campaign_updates), toNull(refunds), toNull(disputes), toNull(milestones), toNull(marketing)]
  );
  res.json(rows[0]);
}));

const { getUserDashboardAnalytics } = require('../services/analyticsService');

router.get('/me/dashboard/analytics', requireAuth, asyncHandler(async (req, res) => {
  const data = await getUserDashboardAnalytics(req.user.userId);
  res.json(data);
}));

// GET /api/users/me — already proposed in issue #163, implement together
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, wallet_public_key, created_at FROM users WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// PATCH /api/users/me — update display name only
router.patch('/me', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { rows } = await db.query(
    `UPDATE users SET name = $1 WHERE id = $2
     RETURNING id, email, name, wallet_public_key, created_at`,
    [name.trim(), req.user.userId]
  );
  res.json(rows[0]);
});

router.use('/api-keys', require('./apiKeys'));

// ── Creator Public Profile (#588) ──────────────────────────────────────────────

// GET /api/users/:id/public — unauthenticated public creator profile
router.get('/:id/public', asyncHandler(async (req, res) => {
  const { rows: userRows } = await db.query(
    `SELECT id, name, wallet_public_key, created_at FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!userRows.length) return res.status(404).json({ error: 'Creator not found' });
  const user = userRows[0];

  const [campaignsRes, statsRes, followersRes] = await Promise.all([
    db.query(
      `SELECT id, title, status, raised_amount, target_amount, asset_type, cover_image_url, deadline, created_at
       FROM campaigns
       WHERE creator_id = $1 AND deleted_at IS NULL AND is_hidden = FALSE
       ORDER BY created_at DESC
       LIMIT 20`,
      [user.id]
    ),
    db.query(
      `SELECT
         COUNT(DISTINCT c.id)::int                          AS total_campaigns,
         COALESCE(SUM(ctr.amount), 0)                       AS total_raised,
         COUNT(DISTINCT ctr.sender_public_key)::int         AS total_backers
       FROM campaigns c
       LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
       WHERE c.creator_id = $1 AND c.deleted_at IS NULL`,
      [user.id]
    ),
    db.query(
      `SELECT COUNT(*)::int AS follower_count
       FROM campaign_followers cf
       JOIN campaigns c ON c.id = cf.campaign_id
       WHERE c.creator_id = $1`,
      [user.id]
    ),
  ]);

  res.json({
    id: user.id,
    name: user.name,
    wallet_public_key: user.wallet_public_key,
    member_since: user.created_at,
    stats: {
      ...statsRes.rows[0],
      follower_count: followersRes.rows[0]?.follower_count ?? 0,
    },
    campaigns: campaignsRes.rows,
  });
}));

// ── Recurring Contributions (#584) ──────────────────────────────────────────────

// GET /api/users/me/recurring-contributions
router.get('/me/recurring-contributions', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT rc.id, rc.campaign_id, c.title AS campaign_title, rc.amount, rc.interval,
            rc.active, rc.next_run_at, rc.last_run_at, rc.run_count, rc.created_at
     FROM recurring_contributions rc
     JOIN campaigns c ON c.id = rc.campaign_id
     WHERE rc.user_id = $1
     ORDER BY rc.created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
}));

// POST /api/users/me/recurring-contributions
router.post('/me/recurring-contributions', requireAuth, asyncHandler(async (req, res) => {
  const { campaign_id, amount, interval } = req.body;
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!['weekly', 'monthly'].includes(interval)) {
    return res.status(400).json({ error: 'interval must be weekly or monthly' });
  }

  const { rows: campaign } = await db.query(
    `SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [campaign_id]
  );
  if (!campaign.length) return res.status(404).json({ error: 'Active campaign not found' });

  const nextRunAt = new Date();
  if (interval === 'weekly') nextRunAt.setDate(nextRunAt.getDate() + 7);
  else nextRunAt.setMonth(nextRunAt.getMonth() + 1);

  const { rows } = await db.query(
    `INSERT INTO recurring_contributions (user_id, campaign_id, amount, interval, next_run_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, campaign_id, amount, interval, active, next_run_at, run_count`,
    [req.user.userId, campaign_id, Number(amount), interval, nextRunAt]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/users/me/recurring-contributions/:id — pause/resume or update amount
router.patch('/me/recurring-contributions/:id', requireAuth, asyncHandler(async (req, res) => {
  const { active, amount } = req.body;
  const updates = [];
  const values = [];
  let idx = 1;
  if (active !== undefined) { updates.push(`active = $${idx++}`); values.push(!!active); }
  if (amount !== undefined) {
    if (isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });
    updates.push(`amount = $${idx++}`); values.push(Number(amount));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  updates.push(`updated_at = NOW()`);
  values.push(req.params.id, req.user.userId);
  const { rows } = await db.query(
    `UPDATE recurring_contributions SET ${updates.join(', ')}
     WHERE id = $${idx} AND user_id = $${idx + 1}
     RETURNING id, campaign_id, amount, interval, active, next_run_at`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Recurring contribution not found' });
  res.json(rows[0]);
}));

// DELETE /api/users/me/recurring-contributions/:id
router.delete('/me/recurring-contributions/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `DELETE FROM recurring_contributions WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Recurring contribution not found' });
  res.status(204).end();
}));

module.exports = router;
