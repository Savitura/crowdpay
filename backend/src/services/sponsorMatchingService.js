const db = require('../config/database');
const logger = require('../config/logger');

const AMOUNT_PRECISION = 7;

function roundAmount(value) {
  return parseFloat(Number(value).toFixed(AMOUNT_PRECISION));
}

function roundPercent(value) {
  return parseFloat(Number(value).toFixed(2));
}

/**
 * Thrown when a sponsor already holds an active matching pledge for a campaign.
 * The unique index added in 20260930_sponsor_matching_hardening.sql makes this
 * deterministic even under concurrent requests, so the API can answer with a
 * stable 409 instead of racing on a read-then-insert check.
 */
class DuplicateMatchingPledgeError extends Error {
  constructor() {
    super('Sponsor already has an active matching pledge for this campaign');
    this.name = 'DuplicateMatchingPledgeError';
    this.code = 'DUPLICATE_MATCHING_PLEDGE';
  }
}

function isDuplicatePledgeViolation(err) {
  return (
    err &&
    err.code === '23505' &&
    typeof err.constraint === 'string' &&
    err.constraint.includes('campaign_matches_active_sponsor')
  );
}

/**
 * Create a sponsor matching pledge for a campaign.
 *
 * @param {Object} params - Parameters
 * @param {string} params.campaignId - Campaign UUID
 * @param {string} params.sponsorUserId - Sponsor user UUID
 * @param {number} params.matchRatio - Match ratio (e.g., 1.0 for 1:1, 2.0 for 2:1)
 * @param {string|number} params.pledgeAmount - Total pool amount in campaign asset
 * @param {Object} [params.client] - Optional transaction client
 * @returns {Promise<Object>} Created campaign_matches row
 */
async function createMatchingPledge({
  campaignId,
  sponsorUserId,
  matchRatio,
  pledgeAmount,
  client,
}) {
  // Validate inputs
  if (!campaignId || !sponsorUserId) {
    throw new Error('campaignId and sponsorUserId are required');
  }
  if (!matchRatio || matchRatio <= 0) {
    throw new Error('matchRatio must be positive');
  }
  if (!pledgeAmount || pledgeAmount <= 0) {
    throw new Error('pledgeAmount must be positive');
  }

  const runner = client || db;

  // Fast path: reject an obvious duplicate before touching the unique index so
  // callers without a transaction still get a clean error.
  const { rows: existing } = await runner.query(
    `SELECT id FROM campaign_matches 
     WHERE campaign_id = $1 AND sponsor_user_id = $2 AND status = 'active'`,
    [campaignId, sponsorUserId]
  );

  if (existing.length > 0) {
    throw new DuplicateMatchingPledgeError();
  }

  let rows;
  try {
    ({ rows } = await runner.query(
      `INSERT INTO campaign_matches 
         (campaign_id, sponsor_user_id, match_ratio, pledge_amount, matched_amount, status)
       VALUES ($1, $2, $3, $4, 0, 'active')
       RETURNING id, campaign_id, sponsor_user_id, match_ratio, pledge_amount, 
                 matched_amount, status, created_at`,
      [campaignId, sponsorUserId, matchRatio, pledgeAmount]
    ));
  } catch (err) {
    // Lost the race against a concurrent pledge from the same sponsor.
    if (isDuplicatePledgeViolation(err)) {
      throw new DuplicateMatchingPledgeError();
    }
    throw err;
  }

  logger.info('Created sponsor matching pledge', {
    campaignId,
    sponsorUserId,
    matchId: rows[0].id,
    pledgeAmount,
    matchRatio,
  });

  return rows[0];
}

/**
 * Process a contribution and apply matching funds if applicable.
 * Returns the amount matched (0 if no matching available).
 *
 * The active pool row is locked with `FOR UPDATE` so two contributions landing
 * at the same time cannot both spend the same pool capacity, and the
 * contribution is claimed exactly once (guarded by `match_amount = 0`) so a
 * replayed/duplicated indexing pass cannot double-match or double-credit it.
 *
 * @param {Object} params - Parameters
 * @param {string} params.campaignId - Campaign UUID
 * @param {string} params.contributionId - Contribution UUID
 * @param {number|string} params.contributionAmount - Amount contributed
 * @param {Object} [params.client] - Optional transaction client
 * @returns {Promise<number>} Amount matched
 */
async function processContributionMatch({
  campaignId,
  contributionId,
  contributionAmount,
  client,
}) {
  const runner = client || db;

  if (!campaignId || !contributionId || !contributionAmount) {
    throw new Error('campaignId, contributionId, and contributionAmount are required');
  }

  const amount = parseFloat(contributionAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error('contributionAmount must be a positive number');
  }

  // Lock the oldest pool that still has capacity. Pools that are already
  // exhausted are skipped here as well as at write time so stale `active`
  // status rows cannot silently absorb a contribution.
  const { rows: matches } = await runner.query(
    `SELECT id, match_ratio, pledge_amount, matched_amount 
     FROM campaign_matches 
     WHERE campaign_id = $1 
       AND status = 'active' 
       AND matched_amount < pledge_amount
     ORDER BY created_at ASC, id ASC
     LIMIT 1
     FOR UPDATE`,
    [campaignId]
  );

  if (!matches.length) {
    // No matching available
    return 0;
  }

  const match = matches[0];

  // Calculate matched amount based on ratio, capped at the remaining pool.
  const calculatedMatch = roundAmount(amount * parseFloat(match.match_ratio));
  const remainingPool = roundAmount(
    parseFloat(match.pledge_amount) - parseFloat(match.matched_amount)
  );
  const actualMatch = roundAmount(Math.min(calculatedMatch, remainingPool));

  if (actualMatch <= 0) {
    return 0;
  }

  // Claim this contribution for matching exactly once. A second call for the
  // same contribution (retry, replayed transaction, concurrent indexer) is a
  // no-op rather than a second spend.
  const { rows: claimed } = await runner.query(
    `UPDATE contributions 
     SET match_amount = $1, campaign_match_id = $2
     WHERE id = $3 AND COALESCE(match_amount, 0) = 0
     RETURNING id`,
    [actualMatch, match.id, contributionId]
  );

  if (!claimed.length) {
    logger.info('Contribution already consumed matching funds; skipping', {
      campaignId,
      contributionId,
      matchId: match.id,
    });
    return 0;
  }

  // Determine if pool becomes exhausted
  const newMatchedAmount = roundAmount(parseFloat(match.matched_amount) + actualMatch);
  const isExhausted = newMatchedAmount >= parseFloat(match.pledge_amount);

  // Update matching pool
  await runner.query(
    `UPDATE campaign_matches 
     SET matched_amount = $1, 
         status = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [newMatchedAmount, isExhausted ? 'exhausted' : 'active', match.id]
  );

  // Sponsor funds are part of the campaign ledger: credit them in the same
  // transaction as the contribution so the campaign total and the exhaustion
  // threshold agree with the matching pool.
  await runner.query(
    `UPDATE campaigns
     SET raised_amount = raised_amount + $1,
         status = CASE
           WHEN raised_amount + $1 >= target_amount THEN 'funded'
           ELSE status
         END
     WHERE id = $2 AND deleted_at IS NULL`,
    [actualMatch, campaignId]
  );

  logger.info('Processed contribution matching', {
    campaignId,
    contributionId,
    matchId: match.id,
    contributionAmount: amount,
    matchRatio: match.match_ratio,
    matchedAmount: actualMatch,
    poolExhausted: isExhausted,
  });

  return actualMatch;
}

/**
 * Get all matching pledges and aggregated progress for a campaign.
 *
 * The response is served by a public endpoint, so it deliberately omits sponsor
 * user IDs and any other internal identifiers.
 *
 * @param {string} campaignId - Campaign UUID
 * @param {Object} [params] - Options
 * @param {Object} [params.client] - Optional transaction client
 * @returns {Promise<Object>} Aggregated matching data
 */
async function getCampaignMatchProgress(campaignId, { client } = {}) {
  const runner = client || db;

  const { rows } = await runner.query(
    `SELECT 
       cm.id,
       cm.sponsor_user_id,
       u.name as sponsor_name,
       cm.match_ratio,
       cm.pledge_amount,
       cm.matched_amount,
       cm.status,
       cm.created_at,
       COUNT(c.id) as contribution_count,
       COALESCE(SUM(c.amount), 0) as total_contributed
     FROM campaign_matches cm
     LEFT JOIN users u ON cm.sponsor_user_id = u.id
     LEFT JOIN contributions c ON cm.id = c.campaign_match_id
     WHERE cm.campaign_id = $1
     GROUP BY cm.id, u.id
     ORDER BY cm.created_at ASC`,
    [campaignId]
  );

  // Calculate aggregates
  const totalPledged = rows.reduce((sum, row) => sum + parseFloat(row.pledge_amount), 0);
  const totalMatched = rows.reduce((sum, row) => sum + parseFloat(row.matched_amount), 0);
  const activeMatches = rows.filter(r => r.status === 'active');
  const exhaustedMatches = rows.filter(r => r.status === 'exhausted');

  return {
    campaignId,
    matches: rows.map(r => ({
      id: r.id,
      sponsorName: r.sponsor_name,
      matchRatio: parseFloat(r.match_ratio),
      pledgeAmount: parseFloat(r.pledge_amount),
      matchedAmount: parseFloat(r.matched_amount),
      remainingAmount: Math.max(0, parseFloat(r.pledge_amount) - parseFloat(r.matched_amount)),
      status: r.status,
      contributionCount: parseInt(r.contribution_count, 10),
      totalContributed: parseFloat(r.total_contributed),
      createdAt: r.created_at,
    })),
    totalPledged: roundAmount(totalPledged),
    totalMatched: roundAmount(totalMatched),
    remainingPoolAmount: Math.max(0, roundAmount(totalPledged - totalMatched)),
    activePoolCount: activeMatches.length,
    exhaustedPoolCount: exhaustedMatches.length,
    percentageUsed: totalPledged > 0 ? roundPercent((totalMatched / totalPledged) * 100) : 0,
  };
}

/**
 * Mark a matching pool as completed (campaign ended).
 * Sponsor can reclaim unmatched funds.
 *
 * @param {string} matchId - Match UUID
 * @param {Object} [params] - Options
 * @param {Object} [params.client] - Optional transaction client
 * @returns {Promise<Object>} Updated match record
 */
async function completeMatchingPledge(matchId, { client } = {}) {
  const runner = client || db;

  const { rows } = await runner.query(
    `UPDATE campaign_matches 
     SET status = 'completed', updated_at = NOW()
     WHERE id = $1 AND status IN ('active', 'exhausted')
     RETURNING *`,
    [matchId]
  );

  if (!rows.length) {
    throw new Error('Match not found or already completed');
  }

  const match = rows[0];
  const unclaimedAmount = parseFloat(match.pledge_amount) - parseFloat(match.matched_amount);

  logger.info('Completed matching pledge', {
    matchId,
    campaignId: match.campaign_id,
    sponsorUserId: match.sponsor_user_id,
    unclaimedAmount,
  });

  return match;
}

/**
 * Get matching pledges for a specific sponsor (across all campaigns).
 *
 * @param {string} sponsorUserId - User UUID
 * @param {Object} [params] - Options
 * @param {Object} [params.client] - Optional transaction client
 * @returns {Promise<Array>} Array of matching records
 */
async function getSponsorMatchingPledges(sponsorUserId, { client } = {}) {
  const runner = client || db;

  const { rows } = await runner.query(
    `SELECT 
       cm.*,
       c.title as campaign_title,
       c.status as campaign_status,
       u.name as sponsor_name
     FROM campaign_matches cm
     JOIN campaigns c ON cm.campaign_id = c.id
     JOIN users u ON cm.sponsor_user_id = u.id
     WHERE cm.sponsor_user_id = $1
     ORDER BY cm.created_at DESC`,
    [sponsorUserId]
  );

  return rows.map(r => ({
    id: r.id,
    campaignId: r.campaign_id,
    campaignTitle: r.campaign_title,
    campaignStatus: r.campaign_status,
    sponsorUserId: r.sponsor_user_id,
    sponsorName: r.sponsor_name,
    matchRatio: parseFloat(r.match_ratio),
    pledgeAmount: parseFloat(r.pledge_amount),
    matchedAmount: parseFloat(r.matched_amount),
    remainingAmount: Math.max(0, parseFloat(r.pledge_amount) - parseFloat(r.matched_amount)),
    status: r.status,
    contractId: r.contract_id,
    createdAt: r.created_at,
  }));
}

module.exports = {
  createMatchingPledge,
  processContributionMatch,
  getCampaignMatchProgress,
  completeMatchingPledge,
  getSponsorMatchingPledges,
  DuplicateMatchingPledgeError,
};
