/**
 * milestoneLedger.js
 *
 * Bookkeeping shared by the manual milestone release route
 * (routes/milestones.js) and the automated release worker
 * (services/milestoneAutoRelease.js). Every function takes the queryable to
 * run on (a pool or a transaction client) so callers control atomicity.
 */

function toReleaseAmount(raisedAmount, releasePercentage) {
  return ((Number(raisedAmount) * Number(releasePercentage)) / 100).toFixed(7);
}

async function logMilestoneEvent(q, { milestoneId, actorUserId, action, note, metadata }) {
  await q.query(
    `INSERT INTO milestone_events (milestone_id, actor_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [milestoneId, actorUserId || null, action, note || null, JSON.stringify(metadata || {})]
  );
}

async function logWithdrawalEvent(q, { withdrawalRequestId, actorUserId, action, note, metadata }) {
  await q.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      withdrawalRequestId,
      actorUserId || null,
      action,
      note || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

async function getMilestoneVoteTally(q, milestoneId, userId) {
  const { rows } = await q.query(
    `SELECT
       COUNT(*) FILTER (WHERE vote = 'approve')::int AS approve_count,
       COUNT(*) FILTER (WHERE vote = 'reject')::int AS reject_count,
       COUNT(*)::int AS total_votes
     FROM milestone_votes
     WHERE milestone_id = $1`,
    [milestoneId]
  );
  const tally = rows[0] || {};
  const approveCount = Number(tally.approve_count || 0);
  const rejectCount = Number(tally.reject_count || 0);
  const totalVotes = Number(tally.total_votes || 0);
  let userVote = null;

  if (userId) {
    const { rows: userRows } = await q.query(
      `SELECT vote, note, created_at, updated_at
       FROM milestone_votes
       WHERE milestone_id = $1 AND user_id = $2`,
      [milestoneId, userId]
    );
    userVote = userRows[0] || null;
  }

  return {
    approve_count: approveCount,
    reject_count: rejectCount,
    total_votes: totalVotes,
    approval_ratio: totalVotes ? approveCount / totalVotes : null,
    user_vote: userVote,
  };
}

/** Contributors block a release when they have voted and approvals do not outnumber rejections. */
function votesBlockRelease(tally) {
  return tally.total_votes > 0 && tally.approve_count <= tally.reject_count;
}

async function setCampaignStatusFromMilestoneProgress(q, campaignId) {
  const { rows } = await q.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'released')::int AS released_count
     FROM milestones
     WHERE campaign_id = $1`,
    [campaignId]
  );
  const total = rows[0]?.total || 0;
  const releasedCount = rows[0]?.released_count || 0;

  if (!total || !releasedCount) return null;

  const nextStatus = releasedCount >= total ? 'completed' : 'in_progress';
  const { rows: updated } = await q.query(
    `UPDATE campaigns
     SET status = $1
     WHERE id = $2 AND status IN ('funded', 'in_progress', 'completed')
     RETURNING id, status`,
    [nextStatus, campaignId]
  );
  return updated[0] || null;
}

module.exports = {
  toReleaseAmount,
  logMilestoneEvent,
  logWithdrawalEvent,
  getMilestoneVoteTally,
  votesBlockRelease,
  setCampaignStatusFromMilestoneProgress,
};
