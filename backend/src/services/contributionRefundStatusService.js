'use strict';

const db = require('../config/database');

function stellarExpertTxUrl(txHash) {
  if (!txHash) return null;
  const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
  const network = isTestnet ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

function domainError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Calculate estimated completion time and remaining duration for a given refund status/stage.
 *
 * SLAs:
 * - Blockchain processing (settlement claimed, transaction submitted): ~5-15 minutes
 * - Settlement stage (approved refund awaiting blockchain settlement): Within 24 hours
 * - Review stage (pending contributor refund request): 2-3 business days (72 hours)
 * - Automatic queue (campaign failed, unrefunded contributions): Within 24-48 hours
 * - Completed: null / 0s / "Completed"
 * - Failed/Rejected/Expired: null / null
 */
function calculateEstimatedCompletionTime({
  status,
  stage,
  createdAt,
  reviewedAt,
  claimedAt,
  deadline,
  now = new Date(),
}) {
  const currentTime = now instanceof Date ? now : new Date(now);

  if (status === 'completed') {
    return {
      estimated_completion_at: null,
      estimated_duration_seconds: 0,
      estimated_time_text: 'Completed',
    };
  }

  if (status === 'rejected' || status === 'expired' || status === 'not_requested') {
    return {
      estimated_completion_at: null,
      estimated_duration_seconds: null,
      estimated_time_text: null,
    };
  }

  if (status === 'failed') {
    return {
      estimated_completion_at: null,
      estimated_duration_seconds: null,
      estimated_time_text: 'Failed — action required',
    };
  }

  if (status === 'processing' || stage === 'blockchain_processing') {
    const start = claimedAt ? new Date(claimedAt) : reviewedAt ? new Date(reviewedAt) : currentTime;
    const target = new Date(start.getTime() + 15 * 60 * 1000); // 15 minutes
    const remainingSeconds = Math.max(
      0,
      Math.round((target.getTime() - currentTime.getTime()) / 1000)
    );
    return {
      estimated_completion_at: target.toISOString(),
      estimated_duration_seconds: remainingSeconds,
      estimated_time_text: '~5–15 minutes',
    };
  }

  if (status === 'approved' || stage === 'settlement') {
    const start = reviewedAt ? new Date(reviewedAt) : currentTime;
    const target = new Date(start.getTime() + 24 * 60 * 60 * 1000); // 24 hours
    const remainingSeconds = Math.max(
      0,
      Math.round((target.getTime() - currentTime.getTime()) / 1000)
    );
    return {
      estimated_completion_at: target.toISOString(),
      estimated_duration_seconds: remainingSeconds,
      estimated_time_text: 'Within 24 hours',
    };
  }

  if (status === 'pending' || stage === 'review') {
    const start = createdAt ? new Date(createdAt) : currentTime;
    const target = new Date(start.getTime() + 72 * 60 * 60 * 1000); // 72 hours (3 days)
    const remainingSeconds = Math.max(
      0,
      Math.round((target.getTime() - currentTime.getTime()) / 1000)
    );
    return {
      estimated_completion_at: target.toISOString(),
      estimated_duration_seconds: remainingSeconds,
      estimated_time_text: '2–3 business days',
    };
  }

  if (status === 'eligible' || stage === 'eligible') {
    const start = deadline ? new Date(deadline) : createdAt ? new Date(createdAt) : currentTime;
    const target = new Date(start.getTime() + 48 * 60 * 60 * 1000); // 48 hours
    const remainingSeconds = Math.max(
      0,
      Math.round((target.getTime() - currentTime.getTime()) / 1000)
    );
    return {
      estimated_completion_at: target.toISOString(),
      estimated_duration_seconds: remainingSeconds,
      estimated_time_text: 'Within 24–48 hours',
    };
  }

  return {
    estimated_completion_at: null,
    estimated_duration_seconds: null,
    estimated_time_text: null,
  };
}

/**
 * Retrieve comprehensive refund status tracking details for a contribution.
 */
async function getContributionRefundStatus(
  contributionId,
  viewerUserId,
  { isAdmin = false, now = new Date() } = {}
) {
  const { rows: contribRows } = await db.query(
    `SELECT c.id, c.campaign_id, c.sender_public_key, c.amount, c.asset, c.tx_hash,
            c.refunded, COALESCE(c.refunded_amount, 0) AS refunded_amount,
            COALESCE(c.refund_reserved_amount, 0) AS refund_reserved_amount,
            c.contract_refunded_at, c.contract_refund_tx_hash, c.created_at,
            camp.title AS campaign_title, camp.status AS campaign_status, camp.deadline,
            camp.creator_id, camp.escrow_contract_id, camp.wallet_public_key AS campaign_wallet
     FROM contributions c
     JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE c.id = $1`,
    [contributionId]
  );

  if (!contribRows.length) {
    throw domainError('Contribution not found', 404);
  }

  const contrib = contribRows[0];

  // Authorization verification
  let isAuthorized = isAdmin || contrib.creator_id === viewerUserId;
  if (!isAuthorized && viewerUserId) {
    const { rows: userRows } = await db.query(`SELECT wallet_public_key FROM users WHERE id = $1`, [
      viewerUserId,
    ]);
    if (userRows.length && userRows[0].wallet_public_key === contrib.sender_public_key) {
      isAuthorized = true;
    } else {
      const { rows: memberRows } = await db.query(
        `SELECT 1 FROM campaign_members
         WHERE campaign_id = $1 AND user_id = $2
           AND role IN ('owner', 'manager') AND accepted_at IS NOT NULL`,
        [contrib.campaign_id, viewerUserId]
      );
      if (memberRows.length) {
        isAuthorized = true;
      }
    }
  }

  if (!isAuthorized) {
    throw domainError('Not authorized to view refund status for this contribution', 403);
  }

  // Look up any refund request
  const { rows: requestRows } = await db.query(
    `SELECT id, status, amount, reason, reviewer_id, rejection_reason, reviewed_at,
            settlement_claimed_at, paid_at, failure_reason, created_at, updated_at
     FROM refund_requests
     WHERE contribution_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [contributionId]
  );
  const refundReq = requestRows[0] || null;

  // Look up any creator refund
  const { rows: creatorRefundRows } = await db.query(
    `SELECT id, status, amount, asset, reason, tx_hash, stellar_tx_hash, processed_at,
            failure_reason, created_at
     FROM creator_refunds
     WHERE contribution_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [contributionId]
  );
  const creatorRefund = creatorRefundRows[0] || null;

  // Look up any withdrawal request (failed-campaign automated refund queue)
  const { rows: withdrawalRows } = await db.query(
    `SELECT id, status, amount, destination_key, unsigned_xdr, created_at, updated_at
     FROM withdrawal_requests
     WHERE contribution_id = $1 AND is_refund = TRUE
     ORDER BY created_at DESC
     LIMIT 1`,
    [contributionId]
  );
  const withdrawalReq = withdrawalRows[0] || null;

  // Fetch refund request events if request exists
  let requestEvents = [];
  if (refundReq?.id) {
    const { rows: events } = await db.query(
      `SELECT id, from_status, to_status, reason, created_at
       FROM refund_request_events
       WHERE request_id = $1
       ORDER BY created_at ASC`,
      [refundReq.id]
    );
    requestEvents = events;
  }

  // Determine unified refund status and stage
  const numericAmount = Number(contrib.amount);
  const refundedAmount = Number(contrib.refunded_amount || 0);
  const remainingRefundable = Math.max(0, numericAmount - refundedAmount);

  let status = 'not_requested';
  let stage = 'none';
  let stageLabel = 'No Refund Requested';
  let stageDescription = 'No refund has been requested or required for this contribution.';
  const txHash =
    contrib.contract_refund_tx_hash ||
    creatorRefund?.stellar_tx_hash ||
    creatorRefund?.tx_hash ||
    null;
  const rejectionReason = refundReq?.rejection_reason || null;
  const failureReason = refundReq?.failure_reason || creatorRefund?.failure_reason || null;

  // 1. Completed
  if (
    contrib.refunded === true ||
    contrib.contract_refunded_at ||
    creatorRefund?.status === 'completed' ||
    refundReq?.status === 'paid' ||
    withdrawalReq?.status === 'submitted'
  ) {
    status = 'completed';
    stage = 'settled';
    stageLabel = 'Refund Settled';
    stageDescription =
      'Refund has been successfully settled and returned to the contributor wallet.';
  }
  // 2. Processing (settlement in flight)
  else if (
    (refundReq && refundReq.status === 'approved' && refundReq.settlement_claimed_at) ||
    creatorRefund?.status === 'processing'
  ) {
    status = 'processing';
    stage = 'blockchain_processing';
    stageLabel = 'Processing on Blockchain';
    stageDescription =
      'The refund transaction is currently being submitted and confirmed on the Stellar network.';
  }
  // 3. Approved (awaiting settlement execution)
  else if (refundReq && refundReq.status === 'approved') {
    status = 'approved';
    stage = 'settlement';
    stageLabel = 'Approved for Settlement';
    stageDescription = 'The refund request has been approved and is queued for blockchain payout.';
  }
  // 4. Pending review or queued
  else if (refundReq && refundReq.status === 'pending') {
    status = 'pending';
    stage = 'review';
    stageLabel = 'Under Review';
    stageDescription =
      'The refund request has been submitted and is awaiting creator or administrator review.';
  } else if (withdrawalReq && withdrawalReq.status === 'pending') {
    status = 'pending';
    stage = 'settlement';
    stageLabel = 'Queued for Payout';
    stageDescription =
      'An automatic refund transaction has been queued for execution following campaign failure.';
  } else if (creatorRefund && creatorRefund.status === 'pending') {
    status = 'pending';
    stage = 'review';
    stageLabel = 'Refund Initiated';
    stageDescription = 'A creator refund has been initiated and is awaiting processing.';
  }
  // 5. Rejected
  else if (refundReq && refundReq.status === 'rejected') {
    status = 'rejected';
    stage = 'rejected';
    stageLabel = 'Refund Rejected';
    stageDescription = rejectionReason
      ? `Refund request was rejected: ${rejectionReason}`
      : 'Refund request was rejected during review.';
  }
  // 6. Expired
  else if (refundReq && refundReq.status === 'expired') {
    status = 'expired';
    stage = 'expired';
    stageLabel = 'Refund Window Expired';
    stageDescription = 'The eligible refund window has passed for this request.';
  }
  // 7. Failed
  else if (creatorRefund?.status === 'failed' || withdrawalReq?.status === 'failed') {
    status = 'failed';
    stage = 'failed';
    stageLabel = 'Refund Failed';
    stageDescription = failureReason
      ? `Refund payout failed: ${failureReason}`
      : 'Refund transaction failed on-chain. Administrator intervention is required.';
  }
  // 8. Eligible (campaign failed, ready for refund)
  else if (contrib.campaign_status === 'failed' && remainingRefundable > 0) {
    status = 'eligible';
    stage = 'eligible';
    stageLabel = 'Eligible for Refund';
    stageDescription =
      'The campaign ended without meeting its goal. You can claim or request an on-chain refund.';
  }

  // Calculate estimated completion
  const est = calculateEstimatedCompletionTime({
    status,
    stage,
    createdAt:
      refundReq?.created_at ||
      creatorRefund?.created_at ||
      withdrawalReq?.created_at ||
      contrib.created_at,
    reviewedAt: refundReq?.reviewed_at,
    claimedAt: refundReq?.settlement_claimed_at,
    deadline: contrib.deadline,
    now,
  });

  // Construct timeline of events
  const events = [];

  // Step 1: Contribution created
  events.push({
    type: 'contribution_confirmed',
    title: 'Contribution confirmed',
    description: `Contributed ${numericAmount} ${contrib.asset}`,
    timestamp: contrib.created_at,
    completed: true,
  });

  // Step 2: Campaign status (if failed)
  if (contrib.campaign_status === 'failed' && contrib.deadline) {
    events.push({
      type: 'campaign_failed',
      title: 'Campaign ended below goal',
      description: 'The campaign did not reach its funding target by the deadline.',
      timestamp: contrib.deadline,
      completed: true,
    });
  }

  // Step 3: Refund request events
  if (requestEvents.length > 0) {
    for (const ev of requestEvents) {
      if (ev.to_status === 'pending') {
        events.push({
          type: 'refund_requested',
          title: 'Refund requested',
          description: ev.reason ? `Reason: ${ev.reason}` : 'Contributor submitted refund request',
          timestamp: ev.created_at,
          completed: true,
        });
      } else if (ev.to_status === 'approved') {
        events.push({
          type: 'refund_approved',
          title: 'Refund approved',
          description: 'Request reviewed and approved for settlement',
          timestamp: ev.created_at,
          completed: true,
        });
      } else if (ev.to_status === 'rejected') {
        events.push({
          type: 'refund_rejected',
          title: 'Refund rejected',
          description: ev.reason ? `Reason: ${ev.reason}` : 'Request was rejected',
          timestamp: ev.created_at,
          completed: true,
        });
      } else if (ev.to_status === 'paid') {
        events.push({
          type: 'refund_settled',
          title: 'Refund paid',
          description: 'Payment confirmed on Stellar network',
          timestamp: ev.created_at,
          completed: true,
        });
      }
    }
  } else if (refundReq) {
    events.push({
      type: 'refund_requested',
      title: 'Refund requested',
      description: refundReq.reason
        ? `Reason: ${refundReq.reason}`
        : 'Contributor submitted refund request',
      timestamp: refundReq.created_at,
      completed: true,
    });
    if (refundReq.reviewed_at) {
      events.push({
        type: `refund_${refundReq.status}`,
        title: `Refund ${refundReq.status}`,
        description: refundReq.rejection_reason || 'Review completed',
        timestamp: refundReq.reviewed_at,
        completed: true,
      });
    }
  }

  // Step 4: Settlement / completion event
  if (status === 'completed' && !events.some(e => e.type === 'refund_settled')) {
    events.push({
      type: 'refund_settled',
      title: 'Refund completed',
      description: txHash
        ? `Confirmed on Stellar ledger (Tx: ${txHash.slice(0, 8)}…)`
        : 'Funds returned to wallet',
      timestamp:
        contrib.contract_refunded_at ||
        creatorRefund?.processed_at ||
        refundReq?.paid_at ||
        new Date().toISOString(),
      completed: true,
    });
  }

  return {
    contribution_id: contrib.id,
    campaign_id: contrib.campaign_id,
    campaign_title: contrib.campaign_title,
    contributor_wallet: contrib.sender_public_key,
    amount: numericAmount,
    asset: contrib.asset,
    refunded_amount: refundedAmount,
    remaining_refundable_amount: remainingRefundable,
    refund_status: status,
    stage,
    stage_label: stageLabel,
    stage_description: stageDescription,
    estimated_completion_at: est.estimated_completion_at,
    estimated_duration_seconds: est.estimated_duration_seconds,
    estimated_time_text: est.estimated_time_text,
    tx_hash: txHash,
    stellar_tx_url: txHash ? stellarExpertTxUrl(txHash) : null,
    rejection_reason: rejectionReason,
    failure_reason: failureReason,
    events,
    created_at: contrib.created_at,
    updated_at:
      refundReq?.updated_at ||
      creatorRefund?.created_at ||
      contrib.contract_refunded_at ||
      contrib.created_at,
  };
}

module.exports = {
  calculateEstimatedCompletionTime,
  getContributionRefundStatus,
};
