const router = require('express').Router();
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const {
  requireAuth,
  requireAdmin,
  IMPERSONATION_TOKEN_COOKIE_NAME,
} = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination } = require('../utils/pagination');
const { revokeAndCloseCampaignWallet } = require('../services/stellarService');
const cache = require('../utils/cache');
const stellar = require('../config/stellar');
const logger = require('../config/logger');
const { IMPERSONATION_TTL_SECONDS, ADMIN_AUDIT_LOG_MAX_LIMIT } = require('../config/constants');
const {
  getFraudDashboard,
  resolveFlaggedContribution,
  retrainModel,
} = require('../services/fraudService');
const auditLogsRouter = require('./auditLogs');
const creatorRefundsRouter = require('./creatorRefunds');
const {
  processDelivery,
  processCampaignWebhookDelivery,
} = require('../services/webhookDispatcher');
const { logAuditEvent, sanitizeMetadata } = require('../services/auditService');
const { recordModerationAction } = require('../services/moderationAuditService');

async function recordPrivilegedAudit(payload) {
  try {
    return await logAuditEvent(payload);
  } catch (err) {
    logger.error('Privileged audit event failed', {
      action: payload.action,
      resource_type: payload.resourceType,
      resource_id: payload.resourceId,
      error: err.message,
    });
    return null;
  }
}

/**
 * @openapi
 * /api/admin/impersonate/exit:
 *   post:
 *     summary: Stop impersonating a user
 *     description: This endpoint only requires authentication (not admin) since it's called by the impersonated user
 */
router.post(
  '/impersonate/exit',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.impersonation) {
      return res.status(403).json({ error: 'Not currently impersonating' });
    }

    await recordModerationAction({
      req,
      client: db,
      actorId: req.impersonation.adminUserId,
      action: 'admin.impersonate_end',
      actionType: 'impersonate_end',
      targetType: 'user',
      targetId: req.impersonation.targetUserId,
      metadata: {
        target_user_id: req.impersonation.targetUserId,
        admin_user_id: req.impersonation.adminUserId,
      },
    });

    res.clearCookie(IMPERSONATION_TOKEN_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    });

    res.json({ success: true });
  })
);

router.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /api/admin/stats:
 *   get:
 *     summary: Get admin dashboard statistics
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [
      usersResult,
      bannedResult,
      campaignStatusResult,
      deletedResult,
      totalRaisedResult,
      contributionsResult,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) FROM users WHERE is_banned = false'),
      db.query('SELECT COUNT(*) FROM users WHERE is_banned = true'),
      db.query('SELECT status, COUNT(*) FROM campaigns WHERE deleted_at IS NULL GROUP BY status'),
      db.query('SELECT COUNT(*) FROM campaigns WHERE deleted_at IS NOT NULL'),
      db.query('SELECT COALESCE(SUM(raised_amount), 0) as total FROM campaigns'),
      db.query('SELECT COUNT(*) FROM contributions'),
    ]);

    res.json({
      total_users: parseInt(usersResult.rows[0]?.count || '0', 10),
      banned_users: parseInt(bannedResult.rows[0]?.count || '0', 10),
      campaign_status: campaignStatusResult.rows,
      deleted_campaigns: parseInt(deletedResult.rows[0]?.count || '0', 10),
      total_raised: parseFloat(totalRaisedResult.rows[0]?.total || '0'),
      total_contributions: parseInt(contributionsResult.rows[0]?.count || '0', 10),
    });
  })
);

/**
 * @openapi
 * /api/admin/health:
 *   get:
 *     summary: Get platform health snapshot
 */
router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const startTime = Date.now();

    const [
      activeCampaignsResult,
      totalRaisedResult,
      pendingWithdrawalsResult,
      openDisputesResult,
      failedWebhooksResult,
      failedCampaignWebhooksResult,
    ] = await Promise.all([
      db.query(
        "SELECT COUNT(*) FROM campaigns WHERE status IN ('active', 'funded') AND deleted_at IS NULL"
      ),
      db.query('SELECT COALESCE(SUM(raised_amount), 0) as total FROM campaigns'),
      db.query(
        "SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total_value FROM withdrawal_requests WHERE status = 'pending'"
      ),
      db.query("SELECT COUNT(*) FROM disputes WHERE status IN ('open', 'pending')"),
      db.query("SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'failed'"),
      db.query("SELECT COUNT(*) FROM campaign_webhook_deliveries WHERE status = 'failed'"),
    ]);

    let stellarHealth = {};
    try {
      const ledgersResponse = await stellar.server.ledgers().order('desc').limit(1).call();
      const feeStats = await stellar.server.feeStats();
      stellarHealth = {
        current_ledger: ledgersResponse.records[0]?.sequence,
        base_fee: feeStats.last_ledger_base_fee,
      };
    } catch (err) {
      logger.error('Failed to fetch Stellar health', { error: err.message });
      stellarHealth = { error: err.message };
    }

    const loadTimeMs = Date.now() - startTime;

    res.json({
      active_campaigns: parseInt(activeCampaignsResult.rows[0]?.count || '0', 10),
      total_raised: parseFloat(totalRaisedResult.rows[0]?.total || '0'),
      pending_withdrawals: {
        count: parseInt(pendingWithdrawalsResult.rows[0]?.count || '0', 10),
        total_value: parseFloat(pendingWithdrawalsResult.rows[0]?.total_value || '0'),
      },
      open_disputes: parseInt(openDisputesResult.rows[0]?.count || '0', 10),
      failed_webhooks: parseInt(failedWebhooksResult.rows[0]?.count || '0', 10),
      failed_campaign_webhooks: parseInt(failedCampaignWebhooksResult.rows[0]?.count || '0', 10),
      stellar: stellarHealth,
      load_time_ms: loadTimeMs,
    });
  })
);

/**
 * @openapi
 * /api/admin/campaigns:
 *   get:
 *     summary: List all campaigns for admin
 */
router.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 50 });

    const countResult = await db.query('SELECT COUNT(*) as total FROM campaigns');
    const dataResult = await db.query(
      'SELECT id, title, status, created_at, deleted_at FROM campaigns ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    res.json({
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
      limit,
      offset,
    });
  })
);

/**
 * @openapi
 * /api/admin/campaigns/{id}/suspend:
 *   patch:
 *     summary: Suspend a campaign
 */
router.patch(
  '/campaigns/:id/suspend',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const campaignResult = await db.query(
      'SELECT id, status, is_flagged_fraud FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignResult.rows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    const updateResult = await db.query(
      `UPDATE campaigns SET status = 'suspended', suspended_reason = $2, suspended_at = NOW() 
     WHERE id = $1 RETURNING id, title, status, created_at`,
      [id, reason]
    );

    const updatedCampaign = updateResult.rows[0] || {};

    await recordModerationAction({
      req,
      client: db,
      action: 'campaign.suspended',
      actionType: 'suspend',
      targetType: 'campaign',
      targetId: id,
      reason: reason || null,
      before: { status: campaign.status, title: campaign.title || updatedCampaign.title },
      after: { status: updatedCampaign.status || 'suspended', suspended_reason: reason || null },
      metadata: { reason: reason || null, campaign_title: updatedCampaign.title || campaign.title },
    });

    cache.invalidatePrefix(`campaign:${id}`);

    res.json({ campaign: updateResult.rows[0] });
  })
);

/**
 * @openapi
 * /api/admin/campaigns/{id}/restore:
 *   patch:
 *     summary: Restore a suspended campaign
 */
router.patch(
  '/campaigns/:id/restore',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};

    const campaignResult = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignResult.rows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    if (campaign.status !== 'suspended') {
      return res.status(400).json({ error: 'Campaign is not suspended' });
    }

    const updateResult = await db.query(
      `UPDATE campaigns SET status = 'active', suspended_reason = NULL, suspended_at = NULL 
     WHERE id = $1 RETURNING id, title, status, created_at`,
      [id]
    );

    const updatedCampaign = updateResult.rows[0] || {};

    await recordModerationAction({
      req,
      client: db,
      action: 'campaign.restored',
      actionType: 'restore',
      targetType: 'campaign',
      targetId: id,
      reason: reason || null,
      before: { status: campaign.status, title: campaign.title || updatedCampaign.title },
      after: { status: updatedCampaign.status || 'active' },
      metadata: { campaign_title: updatedCampaign.title || campaign.title, reason: reason || null },
    });

    cache.invalidatePrefix(`campaign:${id}`);

    res.json({ campaign: updateResult.rows[0] });
  })
);

/**
 * @openapi
 * /api/admin/campaigns/{id}:
 *   delete:
 *     summary: Soft-delete a campaign
 */
router.delete(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const campaignResult = await db.query(
      'SELECT id, title, creator_id, wallet_public_key, wallet_secret_encrypted FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignResult.rows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    if (campaign.wallet_public_key) {
      try {
        await revokeAndCloseCampaignWallet(campaign);
      } catch (err) {
        logger.error('Failed to revoke campaign wallet', { campaignId: id, error: err.message });
      }
    }

    const updateResult = await db.query(
      'UPDATE campaigns SET deleted_at = NOW(), deletion_reason = $2 WHERE id = $1 RETURNING id, title, deleted_at',
      [id, reason]
    );

    const updatedCampaign = updateResult.rows[0] || {};

    await recordModerationAction({
      req,
      client: db,
      action: 'campaign.deleted',
      actionType: 'delete',
      targetType: 'campaign',
      targetId: id,
      reason: reason || null,
      before: {
        status: campaign.status,
        title: campaign.title,
        creator_id: campaign.creator_id,
        wallet_public_key: campaign.wallet_public_key || null,
      },
      after: { deleted_at: updatedCampaign.deleted_at, deletion_reason: reason || null },
      metadata: {
        reason: reason || null,
        campaign_title: campaign.title,
        creator_id: campaign.creator_id,
        wallet_revoked: Boolean(campaign.wallet_public_key),
      },
    });

    cache.invalidatePrefix(`campaign:${id}`);

    res.json({ campaign: updateResult.rows[0] });
  })
);

/**
 * @openapi
 * /api/admin/campaigns/{id}/revisions:
 *   get:
 *     summary: List revision history for a campaign
 */
router.get(
  '/campaigns/:id/revisions',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT id, title, description, target_amount, created_at 
     FROM campaign_revisions 
     WHERE campaign_id = $1 
     ORDER BY created_at DESC`,
      [id]
    );
    res.json(rows);
  })
);

/**
 * @openapi
 * /api/admin/users/{id}/ban:
 *   patch:
 *     summary: Ban a user
 */
router.patch(
  '/users/:id/ban',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const userResult = await db.query('SELECT id, email, is_banned FROM users WHERE id = $1', [id]);

    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = userResult.rows[0];

    const updateResult = await db.query(
      'UPDATE users SET is_banned = true, banned_reason = $2, banned_at = NOW() WHERE id = $1 RETURNING id, email, is_banned',
      [id, reason]
    );

    const updatedUser = updateResult.rows[0] || {};

    await recordModerationAction({
      req,
      client: db,
      action: 'user.banned',
      actionType: 'ban',
      targetType: 'user',
      targetId: id,
      reason,
      before: { is_banned: targetUser.is_banned, email: targetUser.email, role: targetUser.role },
      after: { is_banned: true, banned_reason: reason },
      metadata: { reason, target_user_email: targetUser.email, role: targetUser.role },
    });

    res.json({ user: updateResult.rows[0] });
  })
);

/**
 * @openapi
 * /api/admin/users/{id}/unban:
 *   patch:
 *     summary: Unban a user
 */
router.patch(
  '/users/:id/unban',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};

    const userResult = await db.query('SELECT id, email, is_banned FROM users WHERE id = $1', [id]);

    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = userResult.rows[0];

    const updateResult = await db.query(
      'UPDATE users SET is_banned = false, banned_reason = NULL, banned_at = NULL WHERE id = $1 RETURNING id, email, is_banned',
      [id]
    );

    await recordModerationAction({
      req,
      client: db,
      action: 'user.unbanned',
      actionType: 'unban',
      targetType: 'user',
      targetId: id,
      reason: reason || null,
      before: {
        is_banned: targetUser.is_banned,
        banned_reason: targetUser.banned_reason,
        email: targetUser.email,
      },
      after: { is_banned: false },
      metadata: { reason: reason || null, target_user_email: targetUser.email },
    });

    res.json({ user: updateResult.rows[0] });
  })
);

/**
 * @openapi
 * /api/admin/users/{id}/kyc:
 *   patch:
 *     summary: Update user KYC status
 */
router.patch(
  '/users/:id/kyc',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { kyc_status, reason } = req.body;

    const userResult = await db.query('SELECT id, email, kyc_status FROM users WHERE id = $1', [
      id,
    ]);

    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = userResult.rows[0];

    const updateResult = await db.query(
      'UPDATE users SET kyc_status = $2, kyc_completed_at = NOW() WHERE id = $1 RETURNING id, email, name, kyc_status, kyc_completed_at',
      [id, kyc_status]
    );

    const updatedUser = updateResult.rows[0] || {};

    await recordModerationAction({
      req,
      client: db,
      action: 'user.kyc_override',
      actionType: 'kyc_override',
      targetType: 'user',
      targetId: id,
      reason: reason || null,
      before: { kyc_status: targetUser.kyc_status, email: targetUser.email },
      after: { kyc_status, kyc_completed_at: updatedUser.kyc_completed_at },
      metadata: {
        kyc_status,
        reason: reason || null,
        target_user_email: targetUser.email,
        previous_status: targetUser.kyc_status,
        new_status: kyc_status,
      },
    });

    res.json(updateResult.rows[0]);
  })
);

/**
 * @openapi
 * /api/admin/audit-log:
 *   get:
 *     summary: Get admin audit log
 */
router.get(
  '/audit-log',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, {
      limit: 50,
      max: ADMIN_AUDIT_LOG_MAX_LIMIT,
    });

    const conditions = [];
    const params = [];

    if (req.query.action_type) {
      params.push(req.query.action_type);
      conditions.push(`a.action_type = $${params.length}`);
    }

    if (req.query.target_type) {
      params.push(req.query.target_type);
      conditions.push(`a.target_type = $${params.length}`);
    }

    if (req.query.target_id) {
      params.push(req.query.target_id);
      conditions.push(`a.target_id::text = $${params.length}`);
    }

    if (req.query.admin_user_id) {
      params.push(req.query.admin_user_id);
      conditions.push(`a.admin_user_id::text = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*) FROM admin_actions a ${whereClause}`,
      params
    );

    const dataResult = await db.query(
      `SELECT a.id, a.admin_user_id, u.email as admin_email, a.action_type, a.target_type, a.target_id, a.details, a.created_at
     FROM admin_actions a
     LEFT JOIN users u ON a.admin_user_id = u.id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const sanitizedActions = dataResult.rows.map(row => ({
      ...row,
      details: row.details ? sanitizeMetadata(row.details) : row.details,
    }));

    res.json({
      actions: sanitizedActions,
      total: parseInt(countResult.rows[0]?.count || '0', 10),
      limit,
      offset,
    });
  })
);

/**
 * @openapi
 * /api/admin/withdrawals:
 *   get:
 *     summary: Get withdrawal requests queue
 */
router.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 50 });
    const status = req.query.status || 'pending';

    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM withdrawal_requests WHERE status = $1',
      [status]
    );

    const dataResult = await db.query(
      `SELECT wr.id, c.title as campaign_title, u.name as creator_name, wr.amount, wr.asset_type, 
            wr.status, wr.creator_signed, wr.platform_signed, wr.created_at, wr.evidence
     FROM withdrawal_requests wr
     JOIN campaigns c ON wr.campaign_id = c.id
     JOIN users u ON c.creator_id = u.id
     WHERE wr.status = $1
     ORDER BY wr.created_at DESC
     LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
      limit,
      offset,
    });
  })
);

// Dead letters intentionally expose only delivery metadata and attempt
// outcomes. Payloads, webhook URLs, signing secrets, and request headers stay
// out of the operator response; replay uses the original durable delivery row.
router.get(
  '/webhook-dead-letters',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 50, max: 200 });
    const [countResult, dataResult] = await Promise.all([
      db.query('SELECT COUNT(*) AS total FROM webhook_dead_letters WHERE resolved_at IS NULL'),
      db.query(
        `SELECT id, delivery_kind, delivery_id, webhook_id, event_type, attempt_count,
                last_error, safe_metadata, replay_count, failed_at, resolved_at
           FROM webhook_dead_letters
          WHERE resolved_at IS NULL
          ORDER BY failed_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);
    res.json({
      data: dataResult.rows,
      total: Number(countResult.rows[0]?.total || 0),
      limit,
      offset,
    });
  })
);

router.post(
  '/webhook-dead-letters/:id/replay',
  asyncHandler(async (req, res) => {
    const client = await db.connect();
    let deadLetter;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, delivery_id, delivery_kind
           FROM webhook_dead_letters
          WHERE id = $1 AND resolved_at IS NULL
          FOR UPDATE`,
        [req.params.id]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Open webhook dead letter not found' });
      }

      deadLetter = rows[0];
      const table =
        deadLetter.delivery_kind === 'campaign'
          ? 'campaign_webhook_deliveries'
          : 'webhook_deliveries';
      const { rows: queued } = await client.query(
        `UPDATE ${table}
            SET status = 'pending', attempt_count = 0, last_error = NULL,
                response_status = NULL, next_retry_at = NULL,
                delivered_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status IN ('failed', 'retrying')
          RETURNING id`,
        [deadLetter.delivery_id]
      );
      if (!queued.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Delivery is not in a replayable terminal state' });
      }

      await client.query(
        `UPDATE webhook_dead_letters
            SET replay_count = replay_count + 1, resolved_at = NULL
          WHERE id = $1`,
        [deadLetter.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const runner =
      deadLetter.delivery_kind === 'campaign' ? processCampaignWebhookDelivery : processDelivery;
    setImmediate(() =>
      runner(deadLetter.delivery_id).catch(err =>
        logger.error('Admin webhook dead-letter replay failed', {
          dead_letter_id: deadLetter.id,
          error: err.message,
        })
      )
    );
    await db.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
       VALUES ($1, 'webhook_dead_letter_replay', 'webhook_delivery', $2, $3::jsonb)`,
      [req.user.userId, deadLetter.delivery_id, JSON.stringify({ dead_letter_id: deadLetter.id })]
    );
    res.json({ queued: true, id: deadLetter.id, delivery_id: deadLetter.delivery_id });
  })
);

/**
 * @openapi
 * /api/admin/disputes:
 *   get:
 *     summary: Get disputes list
 */
router.get(
  '/disputes',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 50 });

    const countResult = await db.query('SELECT COUNT(*) as total FROM disputes');

    const dataResult = await db.query(
      `SELECT d.id, d.campaign_id, d.contributor_id, d.status, d.reason, d.created_at
     FROM disputes d
     ORDER BY d.created_at DESC
     LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
      limit,
      offset,
    });
  })
);

/**
 * @openapi
 * /api/admin/kyc/campaigns:
 *   get:
 *     summary: Get campaigns requiring KYC review
 */
router.get(
  '/kyc/campaigns',
  asyncHandler(async (req, res) => {
    const result = await db.query(
      `SELECT c.id, c.title, c.status, u.email, u.kyc_status
     FROM campaigns c
     JOIN users u ON c.creator_id = u.id
     WHERE u.kyc_status IN ('pending', 'unverified')
     ORDER BY c.created_at DESC`
    );

    res.json(result.rows);
  })
);

/**
 * @openapi
 * /api/admin/impersonate/{userId}:
 *   post:
 *     summary: Start impersonating a user
 */
router.post(
  '/impersonate/:userId',
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body || {};

    const userResult = await db.query(
      'SELECT id, email, name, role, is_admin, is_banned FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetUser = userResult.rows[0];

    const token = jwt.sign(
      {
        sub: targetUser.id.toString(),
        iss: 'https://crowdpay.io',
        aud: 'crowdpay-api',
        userId: targetUser.id,
        impersonated_by: req.user.userId,
        impersonation: true,
      },
      process.env.JWT_SECRET,
      { expiresIn: IMPERSONATION_TTL_SECONDS }
    );

    await recordModerationAction({
      req,
      client: db,
      action: 'admin.impersonate_start',
      actionType: 'impersonate_start',
      targetType: 'user',
      targetId: targetUser.id,
      reason: reason || null,
      before: { is_impersonated: false },
      after: { is_impersonated: true },
      metadata: {
        target_email: targetUser.email,
        target_role: targetUser.role,
        reason: reason || null,
        expires_in: IMPERSONATION_TTL_SECONDS,
      },
    });

    res.cookie(IMPERSONATION_TOKEN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: IMPERSONATION_TTL_SECONDS * 1000,
      sameSite: 'strict',
    });

    res.status(201).json({
      token,
      expires_in: IMPERSONATION_TTL_SECONDS,
      user: targetUser,
    });
  })
);

/**
 * @openapi
 * /api/admin/fraud/dashboard:
 *   get:
 *     summary: Get fraud dashboard data
 */
router.get(
  '/fraud/dashboard',
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    const items = await getFraudDashboard({ status, limit, offset });
    res.json({ items });
  })
);

/**
 * @openapi
 * /api/admin/fraud/contributions/{id}/resolve:
 *   post:
 *     summary: Approve or reject flagged contribution
 */
router.post(
  '/fraud/contributions/:id/resolve',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { resolution, reason } = req.body || {};
    const adminUserId = req.user.userId;

    const updated = await resolveFlaggedContribution({
      contributionId: id,
      resolution,
      adminUserId,
    });

    await recordModerationAction({
      req,
      client: db,
      action: 'fraud.contribution_resolved',
      actionType: 'fraud_resolution',
      targetType: 'contribution',
      targetId: id,
      reason: reason || null,
      after: { resolution, status: updated?.status },
      metadata: { resolution, contribution_id: id, reason: reason || null },
    });

    res.json({ success: true, contribution: updated });
  })
);

/**
 * @openapi
 * /api/admin/fraud/retrain:
 *   post:
 *     summary: Retrain fraud scoring model
 */
router.post(
  '/fraud/retrain',
  asyncHandler(async (req, res) => {
    const result = await retrainModel();
    res.json(result);
  })
);

router.use('/audit-logs', auditLogsRouter);
router.use('/refunds', creatorRefundsRouter);

module.exports = router;

// ─── Admin reward-fulfillment oversight (issue #958) ────────────────────────
const {
  getFulfillmentsByCampaign: _adminGetFulfillments,
  updateFulfillmentStatus: _adminUpdateFulfillment,
} = require('../services/rewardTierService');

router.get(
  '/campaigns/:id/fulfillments',
  asyncHandler(async (req, res) => {
    const items = await _adminGetFulfillments(req.params.id, { status: req.query.status });
    res.json({ data: items });
  })
);

router.patch(
  '/fulfillments/:fulfillmentId',
  asyncHandler(async (req, res) => {
    const { status, tracking_number, carrier, notes } = req.body || {};
    if (!status) return res.status(422).json({ error: 'status is required' });
    try {
      const updated = await _adminUpdateFulfillment(req.params.fulfillmentId, status, {
        trackingNumber: tracking_number,
        carrier,
        notes,
      });
      await db.query(
        'INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
        [
          req.user.userId,
          'fulfillment_update',
          'reward_fulfillment',
          req.params.fulfillmentId,
          JSON.stringify({ status }),
        ]
      );
      res.json(updated);
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  })
);
