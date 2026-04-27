const router = require('express').Router();
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
const { insertWithdrawalPendingSignatures } = require('../services/stellarTransactionService');
const { sendEmail } = require('../services/emailService');
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

// List all active campaigns
router.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, description, target_amount, raised_amount, asset_type,
            wallet_public_key, status, creator_id, created_at,
            (SELECT COUNT(*)::int FROM campaign_updates cu WHERE cu.campaign_id = campaigns.id) AS updates_count
     FROM campaigns WHERE status = 'active' ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Get single campaign
router.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  res.json(rows[0]);
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

  const client = await db.connect();
  let campaign;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO campaigns
         (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, description, target_amount, asset_type, wallet.publicKey, req.user.userId, deadline]
    );
    campaign = rows[0];

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

  // Start monitoring the new wallet immediately
  watchCampaignWallet(campaign.id, wallet.publicKey);

  res.status(201).json(campaign);
});

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

router.post('/:id/updates', requireAuth, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: 'title and body are required' });
  }

  const { rows: campaignRows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [req.params.id]);
  if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (campaignRows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only campaign creator can post updates' });
  }

  const { rows } = await db.query(
    `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, campaign_id, author_id, title, body, created_at`,
    [req.params.id, req.user.userId, title.trim(), body.trim()]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
