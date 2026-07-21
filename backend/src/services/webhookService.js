const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { createNotification } = require('./notifications');

// Event types accepted on the inbound webhook endpoint (POST /api/webhooks/incoming/:id).
// These are distinct from the OUTBOUND events in webhookDispatcher.js — inbound
// events are state notifications pushed to us by external systems (anchors,
// signing services, review tooling) that we reflect into local state.
const INCOMING_WEBHOOK_EVENTS = {
  CONTRIBUTION_CONFIRMED: 'contribution.confirmed',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
  ANCHOR_DEPOSIT_UPDATED: 'anchor.deposit.updated',
  MILESTONE_APPROVED: 'milestone.approved',
  MILESTONE_REJECTED: 'milestone.rejected',
};

/**
 * Error type for client-side (4xx) webhook problems — malformed payloads,
 * unknown event types, or resources that don't belong to the webhook owner.
 * The route maps `.status` onto the HTTP response. Anything that throws
 * WITHOUT a status (e.g. a DB failure) surfaces as a 500 so the sender
 * retries — inbound retry is driven by the caller reacting to non-2xx.
 */
class WebhookError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WebhookError';
    this.status = status;
  }
}

/**
 * Timing-safe HMAC-SHA256 verification for inbound webhook bodies.
 * Accepts an optional `sha256=` prefix on the header (GitHub/Stripe style).
 * `rawBody` must be the exact bytes that were signed (a Buffer or string).
 *
 * @returns {boolean} true iff the signature matches.
 */
function verifyWebhookSignature(secret, rawBody, headerSig) {
  if (!secret || !headerSig) return false;

  const provided = String(headerSig).replace(/^sha256=/i, '').trim();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // timingSafeEqual throws on length mismatch, so guard first. Both sides are
  // hex of a fixed-length digest, so an unequal length is already a mismatch.
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf;
  try {
    providedBuf = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length || providedBuf.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Confirmation that an on-chain contribution settled.
 *
 * Idempotent LINK ONLY: the authoritative record of a contribution and the
 * campaign `raised_amount` is owned by the Horizon listener (ledgerMonitor) and
 * the 15-minute reconciliation job. An inbound webhook must never add money —
 * doing so would double-count the same payment. Here we only verify the
 * contribution exists under one of the owner's campaigns and notify; if it
 * hasn't been indexed on-chain yet we acknowledge without side effects.
 */
async function handleContributionConfirmed(ownerUserId, payload) {
  const txHash = payload.tx_hash || payload.txHash;
  if (!txHash) {
    throw new WebhookError('contribution.confirmed requires tx_hash');
  }

  const { rows } = await db.query(
    `SELECT c.id, c.campaign_id, c.amount, c.asset, cam.title
     FROM contributions c
     JOIN campaigns cam ON cam.id = c.campaign_id
     WHERE c.tx_hash = $1 AND cam.creator_id = $2`,
    [txHash, ownerUserId]
  );

  if (!rows.length) {
    // Not yet indexed by the on-chain listener (or not this owner's). Acknowledge
    // so the sender doesn't retry forever; reconciliation is the source of truth.
    logger.info('Incoming contribution.confirmed not yet indexed', { ownerUserId, txHash });
    return { status: 202, body: { received: true, linked: false } };
  }

  const contribution = rows[0];

  // Idempotent: mark the tracked stellar_transaction indexed if it isn't already.
  // Never mutates raised_amount.
  await db.query(
    `UPDATE stellar_transactions
     SET status = 'indexed', contribution_id = $1, updated_at = NOW()
     WHERE tx_hash = $2 AND kind = 'contribution' AND status <> 'indexed'`,
    [contribution.id, txHash]
  );

  await createNotification(ownerUserId, {
    type: 'contribution_confirmed',
    title: 'Contribution confirmed',
    body: `A contribution of ${contribution.amount} ${contribution.asset} to "${contribution.title}" was confirmed on-chain.`,
    link: `/campaigns/${contribution.campaign_id}`,
  }).catch((err) => logger.error('contribution.confirmed notify failed', { error: err.message }));

  return { status: 200, body: { received: true, linked: true, contribution_id: contribution.id } };
}

/**
 * External signing/broadcast service reports a withdrawal has settled on-chain.
 * Transitions the request to `submitted` (the terminal success state) and stores
 * the tx hash. Idempotent — a repeat delivery for an already-submitted request
 * is a no-op that still returns 200.
 */
async function handleWithdrawalCompleted(ownerUserId, payload) {
  const withdrawalId = payload.withdrawal_id || payload.withdrawalId;
  const txHash = payload.tx_hash || payload.txHash || null;
  if (!withdrawalId) {
    throw new WebhookError('withdrawal.completed requires withdrawal_id');
  }

  // Scope to the owner via campaign ownership.
  const { rows } = await db.query(
    `UPDATE withdrawal_requests wr
     SET status = 'submitted',
         tx_hash = COALESCE($3, wr.tx_hash)
     FROM campaigns c
     WHERE wr.id = $1
       AND wr.campaign_id = c.id
       AND c.creator_id = $2
       AND wr.status IN ('pending', 'submitted')
     RETURNING wr.id, wr.campaign_id, wr.amount, wr.status, wr.tx_hash`,
    [withdrawalId, ownerUserId, txHash]
  );

  if (!rows.length) {
    // Either not the owner's, or in a non-completable state (failed/denied).
    const { rows: exists } = await db.query(
      `SELECT wr.id FROM withdrawal_requests wr
       JOIN campaigns c ON c.id = wr.campaign_id
       WHERE wr.id = $1 AND c.creator_id = $2`,
      [withdrawalId, ownerUserId]
    );
    if (!exists.length) {
      throw new WebhookError('Withdrawal not found', 404);
    }
    throw new WebhookError('Withdrawal is not in a completable state', 409);
  }

  const wr = rows[0];
  await createNotification(ownerUserId, {
    type: 'withdrawal_approved',
    title: 'Withdrawal completed',
    body: `Your withdrawal of ${wr.amount} was submitted on-chain.`,
    link: `/campaigns/${wr.campaign_id}`,
  }).catch((err) => logger.error('withdrawal.completed notify failed', { error: err.message }));

  return { status: 200, body: { received: true, withdrawal_id: wr.id, status: wr.status } };
}

// Map a remote SEP-24 anchor transaction status onto our local anchor_deposits
// lifecycle. Mirrors the mapping used when polling in routes/anchor.js.
function mapAnchorStatus(remoteStatus) {
  const s = String(remoteStatus || '').toLowerCase();
  if (s === 'completed') return 'deposit_completed';
  if (['error', 'expired', 'no_market', 'too_small', 'too_large', 'refunded'].includes(s)) {
    return 'failed';
  }
  return null; // still pending — record last_anchor_status but don't advance local state.
}

/**
 * SEP-24 anchor deposit status update. Records the raw remote status/payload and
 * advances the local deposit lifecycle when the remote status is terminal.
 * Contribution submission on top of a completed deposit remains the job of the
 * existing anchor flow — this handler does not move funds.
 */
async function handleAnchorDepositUpdated(ownerUserId, payload) {
  const anchorId = payload.anchor_id || payload.anchorId;
  const anchorTransactionId = payload.anchor_transaction_id || payload.anchorTransactionId;
  const remoteStatus = payload.status;
  if (!anchorId || !anchorTransactionId) {
    throw new WebhookError('anchor.deposit.updated requires anchor_id and anchor_transaction_id');
  }

  const localStatus = mapAnchorStatus(remoteStatus);

  const { rows } = await db.query(
    `UPDATE anchor_deposits
     SET last_anchor_status = $3,
         last_anchor_payload = $4::jsonb,
         status = CASE
           WHEN $5::text IS NOT NULL AND status NOT IN ('completed', 'failed')
             THEN $5::text
           ELSE status
         END,
         updated_at = NOW()
     WHERE anchor_id = $1 AND anchor_transaction_id = $2 AND user_id = $6
     RETURNING id, campaign_id, status`,
    [
      anchorId,
      anchorTransactionId,
      remoteStatus || null,
      JSON.stringify(payload),
      localStatus,
      ownerUserId,
    ]
  );

  if (!rows.length) {
    throw new WebhookError('Anchor deposit not found', 404);
  }

  return { status: 200, body: { received: true, deposit_id: rows[0].id, status: rows[0].status } };
}

/**
 * External review system reports a milestone approval/rejection decision.
 *
 * Reflects the decision into the milestone status (`pending_review` →
 * `approved` | `rejected`) and records an audit event. It deliberately does NOT
 * perform any on-chain release: fund release stays gated behind the platform
 * multisig in the authenticated milestones route. This only mirrors the review
 * outcome and notifies.
 */
async function handleMilestoneDecision(ownerUserId, payload, approved) {
  const milestoneId = payload.milestone_id || payload.milestoneId;
  if (!milestoneId) {
    throw new WebhookError(`${payload.type} requires milestone_id`);
  }
  const reason = payload.reason ? String(payload.reason).trim() : null;
  if (!approved && !reason) {
    throw new WebhookError('milestone.rejected requires a reason');
  }

  const newStatus = approved ? 'approved' : 'rejected';
  const { rows } = await db.query(
    `UPDATE milestones m
     SET status = $3,
         review_note = $4,
         approved_at = CASE WHEN $3 = 'approved' THEN NOW() ELSE NULL END,
         reviewed_at = NOW()
     FROM campaigns c
     WHERE m.id = $1
       AND m.campaign_id = c.id
       AND c.creator_id = $2
       AND m.status = 'pending_review'
     RETURNING m.id, m.campaign_id, m.title, m.status`,
    [milestoneId, ownerUserId, newStatus, reason]
  );

  if (!rows.length) {
    const { rows: exists } = await db.query(
      `SELECT m.id FROM milestones m
       JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.id = $1 AND c.creator_id = $2`,
      [milestoneId, ownerUserId]
    );
    if (!exists.length) {
      throw new WebhookError('Milestone not found', 404);
    }
    throw new WebhookError('Milestone is not awaiting review', 409);
  }

  const milestone = rows[0];
  await db.query(
    `INSERT INTO milestone_events (milestone_id, actor_id, action, note, metadata)
     VALUES ($1, NULL, $2, $3, $4::jsonb)`,
    [milestone.id, newStatus, reason, JSON.stringify({ source: 'incoming_webhook' })]
  );

  await createNotification(ownerUserId, {
    type: approved ? 'milestone_approved' : 'milestone_rejected',
    title: approved ? 'Milestone approved' : 'Milestone rejected',
    body: approved
      ? `Milestone "${milestone.title}" was approved.`
      : `Milestone "${milestone.title}" was rejected: ${reason}`,
    link: `/campaigns/${milestone.campaign_id}`,
  }).catch((err) => logger.error('milestone decision notify failed', { error: err.message }));

  return { status: 200, body: { received: true, milestone_id: milestone.id, status: milestone.status } };
}

/**
 * Route an inbound webhook payload to its handler based on `payload.type`.
 * The caller (routes/webhooks.js) has already verified the HMAC signature and
 * parsed the JSON body. All handlers are scoped to the webhook's owning user so
 * a webhook secret can only mutate resources belonging to that user.
 *
 * @param {string} webhookId  the webhook whose secret authenticated this request
 * @param {object} payload    parsed JSON body; must include a string `type`
 * @returns {Promise<{status:number, body:object}>} HTTP status + response body
 * @throws {WebhookError} for malformed payloads / unknown types / ownership misses
 */
async function processIncomingWebhook(webhookId, payload, { ownerUserId } = {}) {
  logger.info('Processing incoming webhook', { webhookId, eventType: payload && payload.type });

  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    throw new WebhookError('Webhook payload must include a string "type"');
  }

  // The route resolves the owner from the same row it verified the signature
  // against and passes it in. If a caller invokes this directly (e.g. tests,
  // reprocessing) we fall back to looking it up so scoping is never skipped.
  if (!ownerUserId) {
    const { rows } = await db.query(
      `SELECT user_id FROM webhooks WHERE id = $1 AND revoked_at IS NULL`,
      [webhookId]
    );
    if (!rows.length) {
      throw new WebhookError('Webhook not found', 404);
    }
    ownerUserId = rows[0].user_id;
  }

  switch (payload.type) {
    case INCOMING_WEBHOOK_EVENTS.CONTRIBUTION_CONFIRMED:
      return handleContributionConfirmed(ownerUserId, payload);
    case INCOMING_WEBHOOK_EVENTS.WITHDRAWAL_COMPLETED:
      return handleWithdrawalCompleted(ownerUserId, payload);
    case INCOMING_WEBHOOK_EVENTS.ANCHOR_DEPOSIT_UPDATED:
      return handleAnchorDepositUpdated(ownerUserId, payload);
    case INCOMING_WEBHOOK_EVENTS.MILESTONE_APPROVED:
      return handleMilestoneDecision(ownerUserId, payload, true);
    case INCOMING_WEBHOOK_EVENTS.MILESTONE_REJECTED:
      return handleMilestoneDecision(ownerUserId, payload, false);
    default:
      throw new WebhookError(`Unsupported webhook event type: ${payload.type}`);
  }
}

module.exports = {
  processIncomingWebhook,
  verifyWebhookSignature,
  WebhookError,
  INCOMING_WEBHOOK_EVENTS,
};
