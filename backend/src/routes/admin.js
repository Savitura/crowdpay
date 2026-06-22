const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { reconcileSingleCampaign, getRecentReconciliationRuns } = require('../services/reconciliation');
const { server: horizonServer } = require('../config/stellar');
const { processDelivery, processCampaignWebhookDelivery } = require('../services/webhookDispatcher');
const cache = require('../utils/cache');

const VALID_KYC_STATUSES = ['unverified', 'pending', 'verified', 'rejected'];

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
    const { include_banned } = req.query;
    let where = 'WHERE 1=1';

    if (include_banned !== 'true') {
      where += ' AND u.is_banned = false';
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_banned, u.created_at,
              (SELECT COUNT(*) FROM campaigns WHERE creator_id = u.id AND deleted_at IS NULL) as campaign_count,
              (SELECT COUNT(*) FROM contributions WHERE sender_public_key = u.wallet_public_key) as contribution_count
       FROM users u
       ${where}
       ORDER BY u.created_at DESC`,
      []
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
  const allowedStatuses = ['pending', 'approved', 'released'];
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
 * List withdrawal requests across all campaigns for the approval queue.
 */
router.get('/withdrawals', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const params = [status];

    const { rows } = await db.query(
      `SELECT wr.id, wr.campaign_id, wr.amount, wr.destination_key, wr.status,
              wr.creator_signed, wr.platform_signed, wr.denial_reason, wr.created_at,
              c.title AS campaign_title, c.asset_type,
              u.id AS requested_by_id, u.name AS requested_by_name, u.email AS requested_by_email
       FROM withdrawal_requests wr
       JOIN campaigns c ON c.id = wr.campaign_id
       JOIN users u ON u.id = wr.requested_by
       WHERE wr.status = $1
       ORDER BY wr.created_at ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching admin withdrawal queue', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch withdrawal queue' });
  }
});

/**
 * GET /api/admin/users/kyc
 * List users by KYC status for admin oversight.
 */
router.get('/users/kyc', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (status) {
      if (!VALID_KYC_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_KYC_STATUSES.join(', ')}` });
      }
      params.push(status);
      where += ` AND kyc_status = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT id, name, email, kyc_status, kyc_provider_reference, kyc_completed_at, created_at
       FROM users
       ${where}
       ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching users for KYC oversight', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * PATCH /api/admin/users/:id/kyc
 * Manually override a user's KYC status (e.g. verify, or force re-verification).
 */
router.patch('/users/:id/kyc', async (req, res) => {
  try {
    const { id } = req.params;
    const { kyc_status, note } = req.body;

    if (!VALID_KYC_STATUSES.includes(kyc_status)) {
      return res.status(400).json({ error: `kyc_status must be one of: ${VALID_KYC_STATUSES.join(', ')}` });
    }

    const { rows: userRows } = await db.query('SELECT id, kyc_status FROM users WHERE id = $1', [id]);
    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    const previousStatus = userRows[0].kyc_status;

    const { rows: updated } = await db.query(
      `UPDATE users
       SET kyc_status = $1::kyc_status,
           kyc_completed_at = CASE WHEN $1::kyc_status = 'verified' THEN NOW() ELSE NULL END
       WHERE id = $2
       RETURNING id, email, kyc_status, kyc_completed_at`,
      [kyc_status, id]
    );

    await logAdminAction(req.user.userId, 'kyc_override', 'user', id, {
      previous_status: previousStatus,
      new_status: kyc_status,
      note: note || null,
    });

    logger.info('KYC status overridden by admin', { userId: id, adminId: req.user.userId, kyc_status });
    res.json({ message: 'KYC status updated', user: updated[0] });
  } catch (err) {
    logger.error('Error overriding KYC status', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to update KYC status' });
  }
});

/**
 * GET /api/admin/campaigns/:id/kyc-gaps
 * List contributors on a campaign who are not KYC-verified.
 */
router.get('/campaigns/:id/kyc-gaps', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT u.id, u.name, u.email, u.kyc_status
       FROM contributions co
       JOIN users u ON u.wallet_public_key = co.sender_public_key
       WHERE co.campaign_id = $1 AND u.kyc_status != 'verified'`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching campaign KYC gaps', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to fetch KYC gaps' });
  }
});

/**
 * GET /api/admin/health-panel
 * Aggregated platform health stats for the admin dashboard.
 */
router.get('/health-panel', async (req, res) => {
  const withTimeout = (promise, ms, fallback) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

  try {
    const [
      campaignStats,
      pendingWithdrawals,
      openDisputes,
      reconciliationRuns,
      failedWebhooks,
      stellarStatus,
    ] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('active', 'funded')) AS active_campaigns,
                COALESCE(SUM(raised_amount), 0) AS total_raised
         FROM campaigns WHERE deleted_at IS NULL`
      ),
      db.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total_value
         FROM withdrawal_requests WHERE status = 'pending'`
      ),
      db.query(`SELECT COUNT(*) AS count FROM disputes WHERE status IN ('open', 'under_review')`),
      getRecentReconciliationRuns(10),
      db.query(
        `SELECT
           (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'failed') +
           (SELECT COUNT(*) FROM campaign_webhook_deliveries WHERE status = 'failed') AS count`
      ),
      withTimeout(
        (async () => {
          const start = Date.now();
          const ledgers = await horizonServer.ledgers().order('desc').limit(1).call();
          const latencyMs = Date.now() - start;
          const baseFee = await horizonServer.fetchBaseFee();
          return {
            current_ledger: ledgers.records[0]?.sequence ?? null,
            base_fee_stroops: baseFee,
            horizon_latency_ms: latencyMs,
          };
        })(),
        2000,
        { current_ledger: null, base_fee_stroops: null, horizon_latency_ms: null, unavailable: true }
      ),
    ]);

    res.json({
      active_campaigns: parseInt(campaignStats.rows[0].active_campaigns, 10),
      total_raised: parseFloat(campaignStats.rows[0].total_raised),
      pending_withdrawals: {
        count: parseInt(pendingWithdrawals.rows[0].count, 10),
        total_value: parseFloat(pendingWithdrawals.rows[0].total_value),
      },
      open_disputes: parseInt(openDisputes.rows[0].count, 10),
      stellar: stellarStatus,
      recent_reconciliation_runs: reconciliationRuns,
      failed_webhook_deliveries: parseInt(failedWebhooks.rows[0].count, 10),
    });
  } catch (err) {
    logger.error('Error building platform health panel', { error: err.message });
    res.status(500).json({ error: 'Failed to load platform health panel' });
  }
});

/**
 * GET /api/admin/webhooks/deliveries
 * List failed webhook deliveries across both user-level and campaign-level webhooks.
 */
router.get('/webhooks/deliveries', async (req, res) => {
  try {
    const status = req.query.status || 'failed';
    const { rows: userDeliveries } = await db.query(
      `SELECT d.id, 'user' AS kind, d.event_type AS event, d.status, d.attempt_count,
              d.last_error, d.created_at, w.url AS webhook_url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = $1
       ORDER BY d.created_at DESC
       LIMIT 100`,
      [status]
    );
    const { rows: campaignDeliveries } = await db.query(
      `SELECT d.id, 'campaign' AS kind, d.event, d.status, d.attempt_count,
              d.last_error, d.created_at, w.url AS webhook_url
       FROM campaign_webhook_deliveries d
       JOIN campaign_webhooks w ON w.id = d.webhook_id
       WHERE d.status = $1
       ORDER BY d.created_at DESC
       LIMIT 100`,
      [status]
    );

    const combined = [...userDeliveries, ...campaignDeliveries].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
    res.json(combined);
  } catch (err) {
    logger.error('Error fetching webhook deliveries', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch webhook deliveries' });
  }
});

/**
 * POST /api/admin/webhooks/deliveries/:kind/:id/retry
 * Manually trigger a redelivery attempt for a failed webhook delivery.
 */
router.post('/webhooks/deliveries/:kind/:id/retry', async (req, res) => {
  try {
    const { kind, id } = req.params;
    if (!['user', 'campaign'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be "user" or "campaign"' });
    }

    if (kind === 'user') {
      await db.query(`UPDATE webhook_deliveries SET status = 'retrying' WHERE id = $1`, [id]);
      await processDelivery(id);
    } else {
      await db.query(`UPDATE campaign_webhook_deliveries SET status = 'retrying' WHERE id = $1`, [id]);
      await processCampaignWebhookDelivery(id);
    }

    await logAdminAction(req.user.userId, 'retry_webhook_delivery', 'webhook_delivery', id, { kind });
    res.json({ message: 'Retry triggered' });
  } catch (err) {
    logger.error('Error retrying webhook delivery', { error: err.message, deliveryId: req.params.id });
    res.status(500).json({ error: 'Failed to retry webhook delivery' });
  }
});

module.exports = router;
