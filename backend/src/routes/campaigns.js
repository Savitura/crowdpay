const router = require('express').Router();
const multer = require('multer');
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createCampaignWallet,
  getCampaignBalance,
  getSupportedAssetCodes,
  buildWithdrawalTransaction,
} = require('../services/stellarService');
const { encryptSecret } = require('../services/walletService');
const { watchCampaignWallet } = require('../services/ledgerMonitor');
const { watchCampaignWallet, addSSEClient, removeSSEClient } = require('../services/ledgerMonitor');
const { insertWithdrawalPendingSignatures } = require('../services/stellarTransactionService');
const { sendEmail } = require('../services/emailService');
const { uploadCampaignCoverImage } = require('../services/storage');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const {
  createCampaignValidation,
  createCampaignUpdateValidation,
  getCampaignsValidation,
  validateRequest,
} = require('../middleware/validation');

const crypto = require('crypto');

const requireCampaignMember = (...allowedRoles) => {
  return async (req, res, next) => {
    const campaignId = req.params.id || req.params.campaign_id || req.body.campaign_id;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required' });

    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRows[0];

    if (req.user.role === 'admin') {
      req.campaignRole = 'owner';
      return next();
    }

    const { rows: memberRows } = await db.query(
      'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [campaignId, req.user.userId]
    );

    let role = null;
    if (memberRows.length && memberRows[0].accepted_at) {
      role = memberRows[0].role;
    } else if (campaign.creator_id === req.user.userId) {
      role = 'owner';
    }

    if (!role || (allowedRoles.length && !allowedRoles.includes(role))) {
      return res.status(403).json({ error: 'Insufficient permissions for this campaign' });
    }

    req.campaignRole = role;
    next();
  };
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid image type. Only JPG, PNG and WEBP are allowed.'));
    }
    cb(null, true);
  },
});

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const MILESTONE_PERCENT_SCALE = 10000;

function normalizeMilestonesInput(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error('milestones must be an array');
  }
  if (input.length === 0) return [];
  if (input.length > 10) {
    throw new Error('Campaigns can define at most 10 milestones');
  }

  const normalized = input.map((milestone, index) => {
    const title = String(milestone?.title || '').trim();
    if (!title) {
      throw new Error(`Milestone ${index + 1} title is required`);
    }

    const releasePercentage = Number(milestone?.release_percentage);
    if (!Number.isFinite(releasePercentage) || releasePercentage <= 0) {
      throw new Error(`Milestone ${index + 1} release_percentage must be greater than zero`);
    }

    return {
      title,
      description: String(milestone?.description || '').trim() || null,
      release_percentage: releasePercentage.toFixed(4),
      release_percentage_units: Math.round(releasePercentage * MILESTONE_PERCENT_SCALE),
      sort_order: index,
    };
  });

  const totalUnits = normalized.reduce((sum, milestone) => sum + milestone.release_percentage_units, 0);
  if (totalUnits !== 100 * MILESTONE_PERCENT_SCALE) {
    throw new Error('Milestone release percentages must sum to exactly 100%');
  }

  return normalized;
}

async function logWithdrawalEvent(client, { withdrawalRequestId, actorUserId, action, note, metadata }) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [withdrawalRequestId, actorUserId || null, action, note || null, metadata ? JSON.stringify(metadata) : null]
  );
}

// List campaigns with optional search, filtering, sorting, and pagination
router.get('/', getCampaignsValidation, validateRequest, async (req, res) => {
  const { search, status, asset, sort = 'newest' } = req.query;
  const limit = Number(req.query.limit || 20);
  const offset = Number(req.query.offset || 0);
  const filters = [];
  const params = [];

  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  } else {
    filters.push(`status = 'active'`);
  }
  if (asset) {
    params.push(asset);
    filters.push(`asset_type = $${params.length}`);
  }
  if (search) {
    params.push(search);
    filters.push(`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $${params.length})`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const countQuery = `SELECT COUNT(*)::int AS total FROM campaigns ${whereClause}`;
  const countResult = await db.query(countQuery, params);
  const total = countResult.rows[0]?.total || 0;

  const sortExpressions = {
    newest: 'campaigns.created_at DESC',
    ending_soon: 'campaigns.deadline ASC NULLS LAST',
    most_funded: 'campaigns.raised_amount DESC',
    most_backed: '(SELECT COUNT(*) FROM contributions c WHERE c.campaign_id = campaigns.id) DESC',
  };
  const orderBy = sortExpressions[sort] || sortExpressions.newest;

  const query = `
    SELECT campaigns.id, title, description, target_amount, raised_amount, asset_type,
           wallet_public_key, status, creator_id, deadline, cover_image_url, campaigns.created_at,
           u.name AS creator_name,
           u.kyc_status AS creator_kyc_status,
           (SELECT COUNT(*)::int FROM campaign_updates cu WHERE cu.campaign_id = campaigns.id) AS updates_count
    FROM campaigns
    JOIN users u ON u.id = campaigns.creator_id
    SELECT c.*, 
           (SELECT COUNT(*)::int FROM campaign_updates u WHERE u.campaign_id = c.id) AS updates_count,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions con WHERE con.campaign_id = c.id) AS contributor_count
    FROM campaigns c
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;
  const rows = await db.query(query, [...params, limit, offset]);

  res.json({ total, limit, offset, campaigns: rows.rows });
});

// Get single Campaign
router.get('/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, u.name AS creator_name, u.kyc_status AS creator_kyc_status
     FROM campaigns c
     JOIN users u ON u.id = c.creator_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  const query = `
    SELECT *,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions WHERE campaign_id = $1) AS contributor_count
    FROM campaigns
    WHERE id = $1
  `;
  const { rows } = await db.query(query, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  
  const campaign = rows[0];
  let userRole = null;

  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (payload && payload.userId) {
          if (payload.role === 'admin') {
            userRole = 'owner';
          } else if (campaign.creator_id === payload.userId) {
            userRole = 'owner';
          } else {
            const { rows: memberRows } = await db.query(
              'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
              [campaign.id, payload.userId]
            );
            if (memberRows.length && memberRows[0].accepted_at) {
              userRole = memberRows[0].role;
            }
          }
        }
      } catch (err) {
        // Ignore invalid token for public route
      }
    }
  }

  res.json({ ...campaign, user_role: userRole });
});

// Embeddable campaign widget data (public, with permissive CORS)
router.get('/:id/embed', async (req, res) => {
  // Allow this endpoint to be accessed from any origin for embedding
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  const campaignId = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `SELECT id, title, description, target_amount, raised_amount, asset_type, status,
            (SELECT COUNT(*)::int FROM contributions c WHERE c.campaign_id = campaigns.id) AS backer_count
     FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

  const campaign = rows[0];
  const pct = campaign.target_amount
    ? Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100)
    : 0;

  res.json({
    id: campaign.id,
    title: campaign.title,
    description: campaign.description?.slice(0, 200) + (campaign.description?.length > 200 ? '...' : ''),
    raised_amount: Number(campaign.raised_amount),
    target_amount: Number(campaign.target_amount),
    asset_type: campaign.asset_type,
    status: campaign.status,
    backer_count: campaign.backer_count,
    progress_percentage: Math.round(pct * 10) / 10,
    contribution_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${campaign.id}`,
  });
// Get backers for a campaign
router.get('/:id/backers', async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaignRows } = await db.query('SELECT show_backer_amounts FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
  const { show_backer_amounts } = campaignRows[0];

  const query = `
    SELECT 
      display_name,
      sender_public_key,
      ${show_backer_amounts ? 'amount,' : ''}
      asset,
      created_at
    FROM contributions
    WHERE campaign_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await db.query(query, [campaignId]);
  res.json(rows);
});

// SSE stream for real-time campaign funding updates
router.get('/:id/stream', async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('data: {"type":"connected"}\n\n');

  addSSEClient(campaignId, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSSEClient(campaignId, res);
  });
});

// Get live on-chain balance for a campaign
router.get('/:id/balance', async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json(balance);
});

// Scheduled endpoint to fail expired campaigns and prevent further contributions
router.post('/cron/fail-expired', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query(
    `UPDATE campaigns SET status = 'failed'
       WHERE status = 'active'
         AND deadline IS NOT NULL
         AND deadline < CURRENT_DATE
         AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline`
  );

  res.json({ failedCampaigns: rows });
});

// Scheduled endpoint to send 48h deadline reminders
router.post('/cron/reminders', requireAuth, requireRole('admin'), async (req, res) => {
  // Find campaigns ending in exactly 2 days that are still active
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.deadline, u.email as creator_email
     FROM campaigns c
     JOIN users u ON c.creator_id = u.id
     WHERE c.status = 'active'
       AND c.deadline = CURRENT_DATE + INTERVAL '2 days'`
  );

  for (const campaign of rows) {
    sendEmail({
      to: campaign.creator_email,
      subject: `Reminder: Campaign "${campaign.title}" ends in 48 hours`,
      text: `Your campaign "${campaign.title}" is approaching its deadline on ${new Date(campaign.deadline).toDateString()}. 
If your target is reached, you can request a withdrawal. Otherwise, contributions will be refunded.`
    });
  }

  res.json({ remindersSent: rows.length });
});

// Trigger refund withdrawal requests for a failed campaign
router.post('/:id/trigger-refunds', requireAuth, requireRole('admin'), async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaigns } = await db.query(
    `SELECT id, wallet_public_key, status FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];
  if (campaign.status !== 'failed') {
    return res.status(409).json({ error: 'Refunds may only be triggered for failed campaigns' });
  }

  const { rows: contributions } = await db.query(
    `SELECT c.*
       FROM contributions c
       WHERE c.campaign_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM withdrawal_requests wr WHERE wr.contribution_id = c.id
         )
       ORDER BY c.created_at ASC`,
    [campaignId]
  );

  if (!contributions.length) {
    return res.json({ refundsCreated: 0 });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const created = [];
    for (const contribution of contributions) {
      const unsignedXdr = await buildWithdrawalTransaction({
        campaignWalletPublicKey: campaign.wallet_public_key,
        destinationPublicKey: contribution.sender_public_key,
        amount: contribution.amount,
        asset: contribution.asset,
      });

      const { rows: requestRows } = await client.query(
        `INSERT INTO withdrawal_requests
           (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
            creator_signed, platform_signed, contribution_id, is_refund)
         VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6, TRUE)
         RETURNING id`,
        [campaignId, req.user.userId, contribution.amount, contribution.sender_public_key, unsignedXdr, contribution.id]
      );

      const refundRequestId = requestRows[0].id;
      await logWithdrawalEvent(client, {
        withdrawalRequestId: refundRequestId,
        actorUserId: req.user.userId,
        action: 'requested',
        note: 'Refund requested for failed campaign',
        metadata: { contribution_id: contribution.id, amount: contribution.amount, asset: contribution.asset },
      });
      await insertWithdrawalPendingSignatures(client, {
        campaignId,
        withdrawalRequestId: refundRequestId,
        userId: req.user.userId,
        unsignedXdr,
        metadata: { refund_for_contribution_id: contribution.id, amount: contribution.amount, asset: contribution.asset },
      });

      created.push({ contribution_id: contribution.id, refund_request_id: refundRequestId });
    }

    await client.query('COMMIT');
    res.status(201).json({ refundsCreated: created.length, refunds: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[campaigns] Refund trigger failed:', err.message);
    res.status(500).json({ error: 'Could not trigger refunds for campaign' });
  } finally {
    client.release();
  }
});

// Create campaign (authenticated)
router.post('/', requireAuth, requireRole('creator', 'admin'), async (req, res) => {
  const { title, description, target_amount, asset_type, deadline, milestones } = req.body;
  if (!title || !target_amount || !asset_type) {
    return res.status(400).json({ error: 'title, target_amount and asset_type are required' });
  }
  if (!SUPPORTED_ASSETS.includes(asset_type)) {
    return res.status(400).json({
      error: `asset_type must be one of: ${SUPPORTED_ASSETS.join(', ')}`,
    });
  }

  let normalizedMilestones;
  try {
    normalizedMilestones = normalizeMilestonesInput(milestones);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Get creator's public key to add as campaign wallet signer
  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const creatorPublicKey = userRows[0].wallet_public_key;

  // Create the on-chain campaign wallet
  const wallet = await createCampaignWallet(creatorPublicKey);
  const encryptedSecret = encryptSecret(wallet.secret);

    const { rows: userRows } = await db.query(
      'SELECT wallet_public_key, kyc_status FROM users WHERE id = $1',
      'SELECT email, wallet_public_key FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    if (isKycRequiredForCampaigns() && userRows[0].kyc_status !== 'verified') {
      return res.status(403).json({
        error: 'Verify your identity before creating a campaign.',
        code: 'KYC_REQUIRED',
        kyc_status: userRows[0].kyc_status,
      });
    }
    const creatorPublicKey = userRows[0].wallet_public_key;
    const creatorEmail = userRows[0].email;

    const wallet = await createCampaignWallet(creatorPublicKey);

    const client = await db.connect();
    let campaign;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO campaigns
           (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline, min_contribution, max_contribution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [title, description, target_amount, asset_type, wallet.publicKey, req.user.userId, deadline, min_contribution || null, max_contribution || null]
      );
      campaign = rows[0];

      await client.query(
        `INSERT INTO campaign_members
           (campaign_id, user_id, email, role, accepted_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [campaign.id, req.user.userId, creatorEmail, 'owner']
      );

      for (const milestone of normalizedMilestones) {
        await client.query(
          `INSERT INTO milestones
             (campaign_id, title, description, release_percentage, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            campaign.id,
            milestone.title,
            milestone.description,
            milestone.release_percentage,
            milestone.sort_order,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Could not create campaign' });
    } finally {
      client.release();
    }

    watchCampaignWallet(campaign.id, wallet.publicKey);

    res.status(201).json(campaign);
  }
);

router.post(
  '/:id/cover-image',
  requireAuth,
  requireCampaignMember('owner'),
  (req, res, next) => {
    upload.single('cover_image')(req, res, (err) => {
      if (err) {
        return res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message || 'Invalid cover image upload',
            fields: { cover_image: err.message || 'Invalid file' },
          },
        });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'cover_image is required',
          fields: { cover_image: 'No image uploaded' },
        },
      });
    }

    try {
      const coverImageUrl = await uploadCampaignCoverImage(req.params.id, req.file);
      const { rows: updatedRows } = await db.query(
        'UPDATE campaigns SET cover_image_url = $1 WHERE id = $2 RETURNING *',
        [coverImageUrl, req.params.id]
      );
      res.json(updatedRows[0]);
    } catch (err) {
      return res.status(500).json({ error: 'Could not upload campaign cover image' });
    }
  }
);

router.get('/:id/updates', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await db.query(
    `SELECT cu.id, cu.campaign_id, cu.author_id, cu.title, cu.body, cu.created_at, u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset]
  );
  res.json(rows);
});

router.post('/:id/updates', requireAuth, requireCampaignMember('owner', 'manager'), createCampaignUpdateValidation, validateRequest, async (req, res) => {
  const { title, body } = req.body;

  const { rows } = await db.query(
    `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, campaign_id, author_id, title, body, created_at`,
    [req.params.id, req.user.userId, title.trim(), body.trim()]
  );
  res.status(201).json(rows[0]);
});

// POST /campaigns/:id/members — owner invites a user by email
router.post('/:id/members', requireAuth, requireCampaignMember('owner'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(422).json({ error: 'Email and role are required' });
  if (!['owner', 'manager', 'viewer'].includes(role)) {
    return res.status(422).json({ error: 'Invalid role. Must be owner, manager, or viewer' });
  }

  const { rows: users } = await db.query('SELECT id FROM users WHERE email = $1', [email.trim()]);
  const inviteeUserId = users.length ? users[0].id : null;

  const { rows: existing } = await db.query(
    'SELECT id, accepted_at FROM campaign_members WHERE campaign_id = $1 AND email = $2',
    [req.params.id, email.trim()]
  );
  if (existing.length) {
    if (existing[0].accepted_at) {
      return res.status(409).json({ error: 'User is already a member of this campaign' });
    } else {
      return res.status(409).json({ error: 'Invitation already sent to this user' });
    }
  }

  const inviteToken = crypto.randomBytes(32).toString('hex');

  const { rows: memberRows } = await db.query(
    `INSERT INTO campaign_members (campaign_id, user_id, email, role, invited_by, invite_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, campaign_id, email, role, created_at`,
    [req.params.id, inviteeUserId, email.trim(), role, req.user.userId, inviteToken]
  );

  const campaignUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}/invite/${inviteToken}`;
  try {
    await sendEmail({
      to: email.trim(),
      subject: `Invitation to join campaign team`,
      text: `You have been invited to join a campaign as a ${role}. Click here to accept: ${campaignUrl}`,
    });
  } catch (e) {
    console.error('Failed to send invite email', e);
  }

  res.status(201).json(memberRows[0]);
});

// GET /campaigns/:id/members — list current team (owner only)
router.get('/:id/members', requireAuth, requireCampaignMember('owner'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT cm.id, cm.user_id, cm.email, cm.role, cm.accepted_at, cm.created_at,
            u.name AS user_name
     FROM campaign_members cm
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.campaign_id = $1
     ORDER BY cm.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

// PATCH /campaigns/:id/members/:userId — change role (owner only)
router.patch('/:id/members/:userId', requireAuth, requireCampaignMember('owner'), async (req, res) => {
  const { role } = req.body;
  if (!role || !['owner', 'manager', 'viewer'].includes(role)) {
    return res.status(422).json({ error: 'Invalid role. Must be owner, manager, or viewer' });
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET role = $1
     WHERE campaign_id = $2 AND user_id = $3
     RETURNING id, campaign_id, user_id, role, accepted_at`,
    [role, req.params.id, req.params.userId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Member not found' });
  }

  res.json(rows[0]);
});

// DELETE /campaigns/:id/members/:userId — remove member or self-leave
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  const memberUserId = req.params.userId;
  const isSelf = String(memberUserId) === String(req.user.userId);

  let isOwner = false;
  if (req.user.role === 'admin') {
    isOwner = true;
  } else {
    const { rows: ownerRows } = await db.query(
      `SELECT role, accepted_at FROM campaign_members
       WHERE campaign_id = $1 AND user_id = $2 AND role = 'owner'`,
      [req.params.id, req.user.userId]
    );
    if (ownerRows.length && ownerRows[0].accepted_at) isOwner = true;

    const { rows: creatorRows } = await db.query(
      `SELECT creator_id FROM campaigns WHERE id = $1`,
      [req.params.id]
    );
    if (creatorRows.length && creatorRows[0].creator_id === req.user.userId) isOwner = true;
  }

  if (!isSelf && !isOwner) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { rows } = await db.query(
    `DELETE FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2
     RETURNING id`,
    [req.params.id, memberUserId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Member not found' });
  }

  res.json({ message: 'Member removed successfully' });
});

// POST /campaigns/:id/members/accept — accept invitation (token-based)
router.post('/:id/members/accept', requireAuth, async (req, res) => {
  const { token: inviteToken } = req.body;
  if (!inviteToken) return res.status(422).json({ error: 'Invitation token is required' });

  const { rows: invites } = await db.query(
    `SELECT id, accepted_at, email FROM campaign_members
     WHERE campaign_id = $1 AND invite_token = $2`,
    [req.params.id, inviteToken]
  );

  if (!invites.length) {
    return res.status(404).json({ error: 'Invalid invitation token' });
  }
  if (invites[0].accepted_at) {
    return res.status(409).json({ error: 'Invitation already accepted' });
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET user_id = $1, accepted_at = NOW(), invite_token = NULL
     WHERE id = $2
     RETURNING id, campaign_id, user_id, role, accepted_at`,
    [req.user.userId, invites[0].id]
  );

  res.json(rows[0]);
});

module.exports = router;
