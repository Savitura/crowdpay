const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { reconcileSingleCampaign, getRecentReconciliationRuns } = require('../services/reconciliation');
const { server } = require('../config/stellar');
const {
  processDelivery,
  processCampaignWebhookDelivery,
} = require('../services/webhookDispatcher');
const cache = require('../utils/cache');

router.use(requireAuth);
router.use(requireAdmin);

/**
 * Log admin action to audit table
 */
async function logAdminAction(adminUserId, actionType, targetType, targetId, details = null) {
  try {
    await db.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [adminUserId, actionType, targetType, targetId, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    logger.error('Failed to log admin action', { error: err.message, actionType, targetType });
  }
}

/**
 * GET /api/admin/stats
 * Get platform statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const users = await db.query('SELECT COUNT(*) FROM users WHERE is_banned = false');
    const bannedUsers = await db.query('SELECT COUNT(*) FROM users WHERE is_banned = true');
    const campaigns = await db.query('SELECT status, COUNT(*) FROM campaigns WHERE deleted_at IS NULL GROUP BY status');
    const deletedCampaigns = await db.query('SELECT COUNT(*) FROM campaigns WHERE deleted_at IS NOT NULL');
    const raised = await db.query('SELECT SUM(raised_amount) as total FROM campaigns WHERE deleted_at IS NULL');
    const contributions = await db.query('SELECT COUNT(*) FROM contributions');

    res.json({
      total_users: parseInt(users.rows[0].count),
      banned_users: parseInt(bannedUsers.rows[0].count),
      campaign_status: campaigns.rows,
      deleted_campaigns: parseInt(deletedCampaigns.rows[0].count),
      total_raised: parseFloat(raised.rows[0]?.total || 0),
      total_contributions: parseInt(contributions.rows[0].count),
    });
  } catch (err) {
    logger.error('Error fetching admin stats', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/admin/campaigns
 * List all campaigns with filters
 */
router.get('/campaigns', async (req, res) => {
  try {
    const { status, include_deleted } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (include_deleted !== 'true') {
      where += ' AND c.deleted_at IS NULL';
    }

    if (status) {
      params.push(status);
      where += ` AND c.status = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.raised_amount, c.target_amount, 
              c.asset_type, c.created_at, c.deleted_at,
              u.id as creator_id, u.name as creator_name, u.email as creator_email,
              (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) as contribution_count
       FROM campaigns c 
       JOIN users u ON c.creator_id = u.id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching campaigns for admin', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

/**
 * PATCH /api/admin/campaigns/:id/suspend
 * Suspend a campaign (prevent new contributions)
 */
router.patch('/campaigns/:id/suspend', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at`,
      ['suspended', id]
    );

    await logAdminAction(req.user.userId, 'suspend', 'campaign', id, { 
      reason: reason || null,
      previous_status: campaign.status 
    });

    logger.info('Campaign suspended', { campaignId: id, adminId: req.user.userId, reason });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign suspended', campaign: updated[0] });
  } catch (err) {
    logger.error('Error suspending campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to suspend campaign' });
  }
});

/**
 * PATCH /api/admin/campaigns/:id/restore
 * Restore a suspended campaign to active
 */
router.patch('/campaigns/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    if (campaign.status !== 'suspended') {
      return res.status(400).json({ error: 'Only suspended campaigns can be restored' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at`,
      ['active', id]
    );

    await logAdminAction(req.user.userId, 'restore', 'campaign', id, { 
      previous_status: campaign.status 
    });

    logger.info('Campaign restored', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign restored', campaign: updated[0] });
  } catch (err) {
    logger.error('Error restoring campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to restore campaign' });
  }
});

/**
 * DELETE /api/admin/campaigns/:id
 * Soft-delete (archive) a campaign
 */
router.delete('/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, title FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 RETURNING id, title, deleted_at`,
      [id]
    );

    await logAdminAction(req.user.userId, 'delete', 'campaign', id, { 
      reason: reason || null
    });

    logger.info('Campaign deleted', { campaignId: id, adminId: req.user.userId, reason });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign deleted', campaign: updated[0] });
  } catch (err) {
    logger.error('Error deleting campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

/**
 * PATCH /api/admin/campaigns/:id/feature
 * Mark a campaign as featured
 */
router.patch('/campaigns/:id/feature', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns 
       SET featured = true, featured_at = NOW(), featured_note = $1 
       WHERE id = $2 RETURNING id, title, featured, featured_at, featured_note`,
      [note || null, id]
    );

    await logAdminAction(req.user.userId, 'feature', 'campaign', id, { note });

    logger.info('Campaign featured', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidate('campaigns:featured');
    res.json({ message: 'Campaign featured', campaign: updated[0] });
  } catch (err) {
    logger.error('Error featuring campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to feature campaign' });
  }
});

/**
 * PATCH /api/admin/campaigns/:id/unfeature
 * Remove featured status from a campaign
 */
router.patch('/campaigns/:id/unfeature', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns 
       SET featured = false, featured_at = NULL, featured_note = NULL 
       WHERE id = $1 RETURNING id, title, featured`,
      [id]
    );

    await logAdminAction(req.user.userId, 'unfeature', 'campaign', id, {});

    logger.info('Campaign unfeatured', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidate('campaigns:featured');
    res.json({ message: 'Campaign unfeatured', campaign: updated[0] });
  } catch (err) {
    logger.error('Error unfeaturing campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to unfeature campaign' });
  }
});

/**
 * GET /api/admin/users
 * List all users with optional filtering
 */
router.get('/users', async (req, res) => {
  try {
    const { include_banned, kyc_status } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (include_banned !== 'true') {
      where += ' AND u.is_banned = false';
    }

    if (kyc_status) {
      params.push(kyc_status);
      where += ` AND u.kyc_status = $${params.length}::kyc_status`;
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_banned, u.created_at,
              u.kyc_status, u.kyc_completed_at,
              (SELECT COUNT(*) FROM campaigns WHERE creator_id = u.id AND deleted_at IS NULL) as campaign_count,
              (SELECT COUNT(*) FROM contributions WHERE sender_public_key = u.wallet_public_key) as contribution_count
       FROM users u
       ${where}
       ORDER BY u.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching users for admin', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * PATCH /api/admin/users/:id/ban
 * Ban a user
 */
router.patch('/users/:id/ban', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Reason is required for banning a user' });
    }

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_banned FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (user.is_banned) {
      return res.status(400).json({ error: 'User is already banned' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_banned = true WHERE id = $1 RETURNING id, email, is_banned`,
      [id]
    );

    await logAdminAction(req.user.userId, 'ban', 'user', id, { 
      reason: reason
    });

    logger.info('User banned', { userId: id, adminId: req.user.userId, reason });
    res.json({ message: 'User banned', user: updated[0] });
  } catch (err) {
    logger.error('Error banning user', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

/**
 * PATCH /api/admin/users/:id/unban
 * Unban a user
 */
router.patch('/users/:id/unban', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_banned FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (!user.is_banned) {
      return res.status(400).json({ error: 'User is not banned' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_banned = false WHERE id = $1 RETURNING id, email, is_banned`,
      [id]
    );

    await logAdminAction(req.user.userId, 'unban', 'user', id, {});

    logger.info('User unbanned', { userId: id, adminId: req.user.userId });
    res.json({ message: 'User unbanned', user: updated[0] });
  } catch (err) {
    logger.error('Error unbanning user', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

/**
 * GET /api/admin/audit-log
 * Get admin action audit log
 */
router.get('/audit-log', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 100, 1000);
    const offsetNum = parseInt(offset) || 0;

    const { rows } = await db.query(
      `SELECT a.id, a.admin_user_id, u.email as admin_email, a.action_type, 
              a.target_type, a.target_id, a.details, a.created_at
       FROM admin_actions a
       JOIN users u ON a.admin_user_id = u.id
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limitNum, offsetNum]
    );

    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM admin_actions');
    const total = parseInt(countRows[0].count);

    res.json({
      actions: rows,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: total
      }
    });
  } catch (err) {
    logger.error('Error fetching audit log', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

/**
 * PATCH /api/admin/users/:id/promote
 * Promote a user to admin
 */
router.patch('/users/:id/promote', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (user.is_admin) {
      return res.status(400).json({ error: 'User is already an admin' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_admin = true WHERE id = $1 RETURNING id, email, is_admin`,
      [id]
    );

    await logAdminAction(req.user.userId, 'promote', 'user', id, {});

    logger.info('User promoted to admin', { userId: id, adminId: req.user.userId });
    res.json({ message: 'User promoted to admin', user: updated[0] });
  } catch (err) {
    logger.error('Error promoting user', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to promote user' });
  }
});

/**
 * PATCH /api/admin/users/:id/demote
 * Demote an admin to regular user
 */
router.patch('/users/:id/demote', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (!user.is_admin) {
      return res.status(400).json({ error: 'User is not an admin' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_admin = false WHERE id = $1 RETURNING id, email, is_admin`,
      [id]
    );

    await logAdminAction(req.user.userId, 'demote', 'user', id, {});

    logger.info('Admin demoted to user', { userId: id, adminId: req.user.userId });
    res.json({ message: 'Admin demoted to user', user: updated[0] });
  } catch (err) {
    logger.error('Error demoting admin', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to demote user' });
  }
});

// Migrate old /milestones endpoint if needed
router.get('/milestones', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const allowedStatuses = ['pending', 'pending_review', 'rejected', 'approved', 'released'];
  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  const params = [];
  let where = 'WHERE 1=1';
  if (status) {
    params.push(status);
    where += ` AND m.status = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT m.*, c.title AS campaign_title, c.status AS campaign_status, c.asset_type,
            c.raised_amount, u.email AS creator_email, u.name AS creator_name
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     JOIN users u ON u.id = c.creator_id
     ${where}
     ORDER BY m.created_at DESC`,
    params
  );
  res.json(rows);
});

/**
 * POST /api/admin/campaigns/:id/reconcile
 * Manually force a sync for a specific campaign's raised_amount.
 */
router.post('/campaigns/:id/reconcile', async (req, res) => {
  try {
    const result = await reconcileSingleCampaign(req.params.id);
    res.json({ message: 'Reconciliation completed', result });
  } catch (err) {
    if (err.message === 'Campaign not found') {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    logger.error('Error during manual reconciliation', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to reconcile campaign' });
  }
});

/**
 * GET /api/admin/withdrawals
 * Pending withdrawal approval queue
 */
router.get('/withdrawals', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : 'pending';
    const params = [status];
    const { rows } = await db.query(
      `SELECT wr.id, wr.campaign_id, wr.amount, wr.destination_key, wr.status,
              wr.creator_signed, wr.platform_signed, wr.created_at, wr.is_refund,
              c.title AS campaign_title, c.asset_type,
              u.id AS creator_id, u.name AS creator_name, u.email AS creator_email
       FROM withdrawal_requests wr
       JOIN campaigns c ON c.id = wr.campaign_id
       JOIN users u ON u.id = c.creator_id
       WHERE wr.status = $1
       ORDER BY wr.created_at ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching admin withdrawals', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

/**
 * GET /api/admin/disputes
 * List disputes with optional status filter
 */
router.get('/disputes', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (status) {
      params.push(status);
      where += ` AND d.status = $${params.length}`;
    } else {
      where += " AND d.status IN ('open', 'under_review')";
    }

    const { rows } = await db.query(
      `SELECT d.*,
              c.title AS campaign_title, c.asset_type,
              reporter.name AS reporter_name, reporter.email AS reporter_email,
              creator.name AS creator_name, creator.email AS creator_email,
              (SELECT COALESCE(SUM(co.amount::numeric), 0)
               FROM contributions co
               WHERE co.campaign_id = d.campaign_id
                 AND co.sender_public_key = reporter.wallet_public_key) AS amount_in_dispute
       FROM disputes d
       JOIN campaigns c ON c.id = d.campaign_id
       JOIN users reporter ON reporter.id = d.raised_by
       JOIN users creator ON creator.id = c.creator_id
       ${where}
       ORDER BY d.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching admin disputes', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

/**
 * GET /api/admin/disputes/:id
 * Dispute detail with message thread (events + initial report)
 */
router.get('/disputes/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*,
              c.title AS campaign_title, c.asset_type, c.creator_id,
              reporter.name AS reporter_name, reporter.email AS reporter_email,
              creator.name AS creator_name, creator.email AS creator_email,
              (SELECT COALESCE(SUM(co.amount::numeric), 0)
               FROM contributions co
               WHERE co.campaign_id = d.campaign_id
                 AND co.sender_public_key = reporter.wallet_public_key) AS amount_in_dispute
       FROM disputes d
       JOIN campaigns c ON c.id = d.campaign_id
       JOIN users reporter ON reporter.id = d.raised_by
       JOIN users creator ON creator.id = c.creator_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Dispute not found' });

    const { rows: events } = await db.query(
      `SELECT de.*, u.name AS actor_name
       FROM dispute_events de
       LEFT JOIN users u ON u.id = de.actor_id
       WHERE de.dispute_id = $1
       ORDER BY de.created_at ASC`,
      [req.params.id]
    );

    res.json({ dispute: rows[0], thread: events });
  } catch (err) {
    logger.error('Error fetching dispute detail', { error: err.message, disputeId: req.params.id });
    res.status(500).json({ error: 'Failed to fetch dispute' });
  }
});

/**
 * GET /api/admin/kyc/campaigns
 * Campaigns with KYC-unverified contributors
 */
router.get('/kyc/campaigns', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.asset_type,
              COUNT(DISTINCT u.id)::int AS unverified_contributor_count
       FROM campaigns c
       JOIN contributions co ON co.campaign_id = c.id
       JOIN users u ON u.wallet_public_key = co.sender_public_key
       WHERE u.kyc_status != 'verified'
         AND c.deleted_at IS NULL
       GROUP BY c.id, c.title, c.status, c.asset_type
       ORDER BY unverified_contributor_count DESC, c.title ASC`
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching KYC campaign gaps', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch KYC campaign data' });
  }
});

/**
 * PATCH /api/admin/users/:id/kyc
 * Manual KYC override with audit log
 */
router.patch('/users/:id/kyc', async (req, res) => {
  try {
    const { kyc_status, reason } = req.body;
    const VALID = ['unverified', 'pending', 'verified', 'rejected'];
    if (!VALID.includes(kyc_status)) {
      return res.status(400).json({ error: `kyc_status must be one of: ${VALID.join(', ')}` });
    }

    const { rows: userRows } = await db.query('SELECT id, email, kyc_status FROM users WHERE id = $1', [req.params.id]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    const { rows: updated } = await db.query(
      `UPDATE users
       SET kyc_status = $1::kyc_status,
           kyc_completed_at = CASE WHEN $1::kyc_status = 'verified' THEN NOW() ELSE NULL END
       WHERE id = $2
       RETURNING id, email, name, kyc_status, kyc_completed_at`,
      [kyc_status, req.params.id]
    );

    await logAdminAction(req.user.userId, 'kyc_override', 'user', req.params.id, {
      previous_status: userRows[0].kyc_status,
      new_status: kyc_status,
      reason: reason || null,
    });

    res.json(updated[0]);
  } catch (err) {
    logger.error('Error updating user KYC', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to update KYC status' });
  }
});

/**
 * GET /api/admin/health
 * Platform health panel (target load <2s)
 */
router.get('/health', async (req, res) => {
  const started = Date.now();
  try {
    const [
      activeCampaigns,
      totalRaised,
      pendingWithdrawals,
      openDisputes,
      failedUserWebhooks,
      failedCampaignWebhooks,
      recentReconciliation,
    ] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS count FROM campaigns WHERE status IN ('active', 'funded') AND deleted_at IS NULL"),
      db.query('SELECT COALESCE(SUM(raised_amount), 0)::numeric AS total FROM campaigns WHERE deleted_at IS NULL'),
      db.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount::numeric), 0)::numeric AS total_value
         FROM withdrawal_requests WHERE status = 'pending'`
      ),
      db.query("SELECT COUNT(*)::int AS count FROM disputes WHERE status IN ('open', 'under_review')"),
      db.query("SELECT COUNT(*)::int AS count FROM webhook_deliveries WHERE status = 'failed'"),
      db.query("SELECT COUNT(*)::int AS count FROM campaign_webhook_deliveries WHERE status = 'failed'"),
      Promise.resolve(getRecentReconciliationRuns()),
    ]);

    let stellar = null;
    try {
      const horizonStart = Date.now();
      const [ledgerRes, feeRes] = await Promise.all([
        server.ledgers().order('desc').limit(1).call(),
        server.feeStats(),
      ]);
      stellar = {
        current_ledger: ledgerRes.records[0]?.sequence || null,
        base_fee_stroops: feeRes.last_ledger_base_fee,
        horizon_latency_ms: Date.now() - horizonStart,
        network: process.env.STELLAR_NETWORK || 'testnet',
      };
    } catch (err) {
      stellar = { error: err.message || 'Horizon unavailable' };
    }

    res.json({
      active_campaigns: activeCampaigns.rows[0].count,
      total_raised: parseFloat(totalRaised.rows[0].total),
      pending_withdrawals: {
        count: pendingWithdrawals.rows[0].count,
        total_value: parseFloat(pendingWithdrawals.rows[0].total_value),
      },
      open_disputes: openDisputes.rows[0].count,
      failed_webhook_deliveries: failedUserWebhooks.rows[0].count + failedCampaignWebhooks.rows[0].count,
      stellar,
      recent_reconciliation_runs: recentReconciliation.slice(0, 5),
      load_time_ms: Date.now() - started,
    });
  } catch (err) {
    logger.error('Error fetching admin health', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch platform health' });
  }
});

/**
 * GET /api/admin/webhook-deliveries
 * Failed webhook deliveries for admin oversight
 */
router.get('/webhook-deliveries', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const status = req.query.status ? String(req.query.status) : 'failed';

    const { rows: userRows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event_type, d.status, d.attempt_count, d.last_error,
              d.created_at, d.updated_at, w.url AS webhook_url, 'user' AS delivery_kind
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = $1
       ORDER BY d.updated_at DESC
       LIMIT $2`,
      [status, limit]
    );

    const { rows: campaignRows } = await db.query(
      `SELECT d.id, d.webhook_id, d.event_type, d.status, d.attempt_count, d.last_error,
              d.created_at, d.updated_at, w.url AS webhook_url, 'campaign' AS delivery_kind
       FROM campaign_webhook_deliveries d
       JOIN campaign_webhooks w ON w.id = d.webhook_id
       WHERE d.status = $1
       ORDER BY d.updated_at DESC
       LIMIT $2`,
      [status, limit]
    );

    res.json([...userRows, ...campaignRows].sort(
      (a, b) => new Date(b.updated_at) - new Date(a.updated_at)
    ).slice(0, limit));
  } catch (err) {
    logger.error('Error fetching webhook deliveries', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch webhook deliveries' });
  }
});

/**
 * POST /api/admin/webhook-deliveries/:id/retry
 * Retry a failed webhook delivery
 */
router.post('/webhook-deliveries/:id/retry', async (req, res) => {
  try {
    const kind = req.body?.kind === 'campaign' ? 'campaign' : 'user';
    const table = kind === 'campaign' ? 'campaign_webhook_deliveries' : 'webhook_deliveries';

    const { rows } = await db.query(
      `UPDATE ${table}
       SET status = 'pending', next_retry_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status IN ('failed', 'retrying')
       RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Failed delivery not found or not retryable' });
    }

    await logAdminAction(req.user.userId, 'webhook_retry', 'webhook_delivery', req.params.id, { kind });

    const processor = kind === 'campaign' ? processCampaignWebhookDelivery : processDelivery;
    setImmediate(() => {
      processor(req.params.id).catch((err) => {
        logger.error('Admin webhook retry failed', { deliveryId: req.params.id, error: err.message });
      });
    });

    res.json({ message: 'Retry queued', id: req.params.id, kind });
  } catch (err) {
    logger.error('Error retrying webhook delivery', { error: err.message, deliveryId: req.params.id });
    res.status(500).json({ error: 'Failed to retry webhook delivery' });
  }
});

/**
 * GET /api/admin/campaigns/:id/contributions
 * Contributor audit trail for withdrawal review
 */
router.get('/campaigns/:id/contributions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const { rows } = await db.query(
      `SELECT co.id, co.amount, co.asset, co.tx_hash, co.created_at,
              co.sender_public_key, u.name AS contributor_name, u.email AS contributor_email,
              u.kyc_status AS contributor_kyc_status
       FROM contributions co
       LEFT JOIN users u ON u.wallet_public_key = co.sender_public_key
       WHERE co.campaign_id = $1
       ORDER BY co.created_at DESC
       LIMIT $2`,
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching campaign contributions for admin', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

module.exports = router;
