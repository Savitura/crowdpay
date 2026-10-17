const db = require('../config/database');
const { createNotification } = require('./notifications');
const { logAuditEvent } = require('./auditService');
const refundService = require('./refundService');

const REQUEST_WINDOW_DAYS = Number(process.env.REFUND_REQUEST_WINDOW_DAYS || 30);
const ACTIVE_STATES = new Set(['pending', 'approved']);

function domainError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function withinRequestWindow(deadline, now = new Date()) {
  if (!deadline) return false;
  const end = new Date(deadline);
  end.setUTCDate(end.getUTCDate() + REQUEST_WINDOW_DAYS);
  return now >= new Date(deadline) && now <= end;
}

async function recordEvent(client, requestId, actorId, fromStatus, toStatus, reason = null) {
  await client.query(
    `INSERT INTO refund_request_events (request_id, actor_id, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [requestId, actorId, fromStatus, toStatus, reason]
  );
}

async function createRequest({
  campaignId,
  contributionId,
  contributorId,
  amount,
  reason,
  now = new Date(),
}) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0)
    throw domainError('Refund amount must be positive');
  if (typeof reason !== 'string' || !reason.trim()) throw domainError('Refund reason is required');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.id AS campaign_id, c.creator_id, c.status AS campaign_status, c.deadline,
              co.id AS contribution_id, co.amount AS contribution_amount,
              COALESCE(co.refunded_amount, 0) AS refunded_amount,
              COALESCE(co.refund_reserved_amount, 0) AS refund_reserved_amount,
              co.status AS contribution_status, co.sender_public_key
       FROM campaigns c JOIN contributions co ON co.campaign_id = c.id
       JOIN users contributor ON contributor.wallet_public_key = co.sender_public_key
       WHERE c.id = $1 AND co.id = $2 AND contributor.id = $3
       FOR UPDATE OF co`,
      [campaignId, contributionId, contributorId]
    );
    if (!rows.length) throw domainError('Contribution not found or not owned by contributor', 404);
    const contribution = rows[0];
    if (contribution.campaign_status !== 'failed')
      throw domainError('Campaign is not eligible for refunds', 409);
    if (contribution.contribution_status === 'refunded')
      throw domainError('Contribution has already been fully refunded', 409);
    if (!withinRequestWindow(contribution.deadline, now))
      throw domainError('Refund request window is closed', 409);

    const reserved = await client.query(
      `UPDATE contributions
       SET refund_reserved_amount = COALESCE(refund_reserved_amount, 0) + $1
       WHERE id = $2
         AND amount - COALESCE(refunded_amount, 0) - COALESCE(refund_reserved_amount, 0) >= $1
       RETURNING refund_reserved_amount`,
      [numericAmount, contributionId]
    );
    if (!reserved.rows.length)
      throw domainError('Refund amount exceeds the remaining refundable balance', 409);

    const inserted = await client.query(
      `INSERT INTO refund_requests (campaign_id, contribution_id, contributor_id, amount, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [campaignId, contributionId, contributorId, numericAmount, reason.trim()]
    );
    const request = inserted.rows[0];
    await recordEvent(client, request.id, contributorId, null, 'pending', reason.trim());
    await client.query('COMMIT');
    await Promise.allSettled([
      createNotification(contribution.creator_id || campaignId, {
        type: 'refund_request_submitted',
        title: 'Refund request submitted',
        body: 'A contributor submitted a refund request for your campaign.',
      }),
      logAuditEvent({
        actorId: contributorId,
        action: 'refund_request_submitted',
        resourceType: 'refund_request',
        resourceId: request.id,
        metadata: { campaignId, contributionId, amount: numericAmount },
      }),
    ]);
    return request;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function canReview(client, request, reviewerId, isAdmin = false) {
  if (isAdmin || request.creator_id === reviewerId) return true;
  const { rows } = await client.query(
    `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager') AND accepted_at IS NOT NULL`,
    [request.campaign_id, reviewerId]
  );
  return rows.length > 0;
}

async function reviewRequest(id, { reviewerId, approve, rejectionReason, isAdmin = false }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT rr.*, c.creator_id, c.deadline FROM refund_requests rr
       JOIN campaigns c ON c.id = rr.campaign_id WHERE rr.id = $1 FOR UPDATE`,
      [id]
    );
    if (!result.rows.length) throw domainError('Refund request not found', 404);
    const request = result.rows[0];
    if (!(await canReview(client, request, reviewerId, isAdmin)))
      throw domainError('Not authorized to review this request', 403);
    if (request.status !== 'pending') throw domainError('Refund request is not pending', 409);
    if (!withinRequestWindow(request.deadline)) {
      await client.query(
        `UPDATE refund_requests SET status = 'expired', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      await recordEvent(client, id, null, 'pending', 'expired');
      await client.query('COMMIT');
      throw domainError('Refund request has expired', 409);
    }
    if (!approve && (!rejectionReason || !rejectionReason.trim()))
      throw domainError('Rejection reason is required');
    const next = approve ? 'approved' : 'rejected';
    const { rows } = await client.query(
      `UPDATE refund_requests SET status = $1, reviewer_id = $2, rejection_reason = $3,
         reviewed_at = NOW(), updated_at = NOW() WHERE id = $4 RETURNING *`,
      [next, reviewerId, approve ? null : rejectionReason.trim(), id]
    );
    if (!approve)
      await client.query(
        `UPDATE contributions SET refund_reserved_amount = GREATEST(0, refund_reserved_amount - $1) WHERE id = $2`,
        [request.amount, request.contribution_id]
      );
    await recordEvent(
      client,
      id,
      reviewerId,
      'pending',
      next,
      approve ? null : rejectionReason.trim()
    );
    await client.query('COMMIT');
    await Promise.allSettled([
      createNotification(request.contributor_id, {
        type: `refund_request_${next}`,
        title: `Refund request ${next}`,
        body: approve ? 'Your refund request was approved.' : rejectionReason.trim(),
      }),
      logAuditEvent({
        actorId: reviewerId,
        action: `refund_request_${next}`,
        resourceType: 'refund_request',
        resourceId: id,
        metadata: { rejectionReason: approve ? undefined : rejectionReason.trim() },
      }),
    ]);
    return rows[0];
  } catch (error) {
    if (error.status !== 409 || !String(error.message).includes('expired'))
      await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function payRequest(id, { actorId, service }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: requestRows } = await client.query(
      `SELECT rr.*, c.creator_id FROM refund_requests rr
       JOIN campaigns c ON c.id = rr.campaign_id WHERE rr.id = $1 FOR UPDATE`,
      [id]
    );
    if (!requestRows.length) throw domainError('Refund request not found', 404);
    const request = requestRows[0];
    if (request.contributor_id !== actorId && !(await canReview(client, request, actorId))) {
      throw domainError('Not authorized to settle this request', 403);
    }
    const { rows } = await client.query(
      `UPDATE refund_requests SET settlement_claimed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'approved' AND settlement_claimed_at IS NULL RETURNING *`,
      [id]
    );
    if (!rows.length)
      throw domainError('Refund request is not approved or is already being settled', 409);
    await client.query('COMMIT');
    try {
      await refundService.processRefund(request.contribution_id, request.amount, service);
      const paid = await db.query(
        `UPDATE refund_requests SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'approved' RETURNING *`,
        [id]
      );
      await db.query(
        `UPDATE contributions SET refund_reserved_amount = GREATEST(0, refund_reserved_amount - $1) WHERE id = $2`,
        [request.amount, request.contribution_id]
      );
      const c = await db.connect();
      try {
        await recordEvent(c, id, actorId, 'approved', 'paid');
      } finally {
        c.release();
      }
      return paid.rows[0];
    } catch (error) {
      await db.query(
        `UPDATE refund_requests SET settlement_claimed_at = NULL, failure_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'approved'`,
        [id, error.message]
      );
      throw error;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getRequest(id, viewerId, isAdmin = false) {
  const { rows } = await db.query(
    `SELECT rr.*, c.creator_id FROM refund_requests rr JOIN campaigns c ON c.id = rr.campaign_id WHERE rr.id = $1`,
    [id]
  );
  if (!rows.length) throw domainError('Refund request not found', 404);
  const r = rows[0];
  if (!isAdmin && r.contributor_id !== viewerId && r.creator_id !== viewerId) {
    const membership = await db.query(
      `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager') AND accepted_at IS NOT NULL`,
      [r.campaign_id, viewerId]
    );
    if (!membership.rows.length) throw domainError('Not authorized to view this request', 403);
  }
  const events = await db.query(
    `SELECT id, actor_id, from_status, to_status, reason, created_at
     FROM refund_request_events WHERE request_id = $1 ORDER BY created_at`,
    [id]
  );
  r.events = events.rows;
  return r;
}

async function listRequests(campaignId, viewerId, isAdmin = false) {
  const { rows } = await db.query(
    `SELECT rr.*, c.creator_id FROM refund_requests rr
     JOIN campaigns c ON c.id = rr.campaign_id
     WHERE rr.campaign_id = $1
       AND ($2 = TRUE OR rr.contributor_id = $3 OR c.creator_id = $3 OR EXISTS (
         SELECT 1 FROM campaign_members cm WHERE cm.campaign_id = rr.campaign_id
           AND cm.user_id = $3 AND cm.role IN ('owner', 'manager') AND cm.accepted_at IS NOT NULL
       ))
     ORDER BY rr.created_at DESC`,
    [campaignId, isAdmin, viewerId]
  );
  return rows;
}

module.exports = {
  createRequest,
  reviewRequest,
  payRequest,
  getRequest,
  listRequests,
  withinRequestWindow,
  ACTIVE_STATES,
};
