const db = require('../config/database');
const logger = require('../config/logger');
const { logAuditEvent, sanitizeMetadata } = require('./auditService');

/**
 * Record a structured administrative moderation action.
 * Dual-writes to:
 *   1. `audit_logs` (tamper-evident, append-only privileged audit trail)
 *   2. `admin_actions` (administrative action history with structured details)
 *
 * @param {object} params
 * @param {import('express').Request} [params.req]          Express request object for context
 * @param {string} [params.actorId]                         Admin user ID (defaults to req.user.userId)
 * @param {string} params.action                           Standard action verb (e.g. 'campaign.suspended', 'user.banned')
 * @param {string} params.actionType                       Action type code for admin_actions (e.g. 'suspend', 'ban')
 * @param {string} params.targetType                       Target resource type (e.g. 'campaign', 'user', 'contribution')
 * @param {string|number} params.targetId                  Target resource ID
 * @param {string} [params.reason]                         Moderation rationale or justification
 * @param {object} [params.before]                         Pre-action state snapshot
 * @param {object} [params.after]                          Post-action state snapshot
 * @param {object} [params.metadata]                       Additional action-specific context
 * @param {object} [params.client]                         Optional database transaction client or pool
 * @returns {Promise<{ auditLog: object|null, adminAction: object|null }>}
 */
async function recordModerationAction({
  req = null,
  actorId = null,
  action,
  actionType,
  targetType,
  targetId,
  reason = null,
  before = {},
  after = {},
  metadata = {},
  client = null,
}) {
  const runner = client || db;
  const resolvedActorId = actorId || req?.user?.userId || req?.impersonation?.adminUserId || null;
  const actorEmail = req?.user?.email || null;
  const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
  const userAgent = req?.headers?.['user-agent'] || null;
  const correlationId = req?.id || req?.headers?.['x-request-id'] || null;

  const resolvedReason = reason || req?.body?.reason || metadata?.reason || null;

  // Build sanitized structured metadata
  const enrichedMetadata = {
    ...metadata,
    reason: resolvedReason,
    ...(actorEmail ? { actor_email: actorEmail } : {}),
  };

  const safeBefore = sanitizeMetadata(before);
  const safeAfter = sanitizeMetadata(after);
  const safeMetadata = sanitizeMetadata(enrichedMetadata);

  // 1. Record append-only privileged audit event
  let auditLog = null;
  try {
    auditLog = await logAuditEvent({
      actorId: resolvedActorId,
      action,
      resourceType: targetType,
      resourceId: targetId !== null && targetId !== undefined ? String(targetId) : null,
      before: safeBefore,
      after: safeAfter,
      metadata: safeMetadata,
      correlationId,
      req,
      client: runner,
    });
  } catch (err) {
    logger.error('Failed to log privileged audit event for moderation action', {
      action,
      targetType,
      targetId,
      error: err.message,
    });
  }

  // 2. Record to admin_actions with structured details
  let adminAction = null;
  if (resolvedActorId) {
    const structuredDetails = sanitizeMetadata({
      reason: resolvedReason,
      ...metadata,
      before: safeBefore,
      after: safeAfter,
      actor_email: actorEmail,
      ip_address: ipAddress,
      user_agent: userAgent,
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
    });

    try {
      const { rows } = await runner.query(
        `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, admin_user_id, action_type, target_type, target_id, details, created_at`,
        [
          resolvedActorId,
          actionType || action,
          targetType,
          targetId,
          JSON.stringify(structuredDetails),
        ]
      );
      adminAction = rows?.[0] || null;
    } catch (err) {
      logger.warn('Failed to insert structured admin_actions entry', {
        actionType,
        targetType,
        targetId,
        error: err.message,
      });
    }
  }

  return { auditLog, adminAction };
}

module.exports = {
  recordModerationAction,
};
