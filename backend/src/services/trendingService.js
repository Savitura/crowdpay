'use strict';

// backend/src/services/trendingService.js
//
// Issue #690 — trending algorithm.
//
// Score formula (0-100):
//   (contributions_last_24h / max_contributions_24h * 40)
// + (percent_funded * 30)
// + (unique_contributors_last_7d / max_contributors_7d * 20)
// + (days_until_deadline_score * 10)
//
// days_until_deadline_score: campaigns with 1-7 days remaining score highest
// (urgency boost); campaigns with > 30 days remaining score lowest.
//
// Recomputed on a 15-minute cron (see startTrendingCron in src/index.js) and
// cached in-process via TtlCache (this app has no Redis dependency — TtlCache
// is the existing in-repo substitute used by every other "cached discovery
// endpoint", e.g. campaignsCache in routes/campaigns.js).

const db = require('../config/database');
const logger = require('../config/logger');
const { TtlCache } = require('../utils/TtlCache');

const TRENDING_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const trendingCache = new TtlCache(TRENDING_CACHE_TTL_MS);
const TRENDING_CACHE_KEY = 'trending:top20';

/**
 * days_until_deadline_score, 0-1.
 * 1-7 days remaining -> 1.0 (urgency boost)
 * 8-30 days remaining -> linear taper
 * > 30 days or no deadline -> 0 (lowest)
 * already ended -> 0
 */
function deadlineScore(daysRemaining) {
  if (daysRemaining === null || daysRemaining === undefined) return 0;
  if (daysRemaining < 0) return 0;
  if (daysRemaining <= 7) return 1;
  if (daysRemaining > 30) return 0;
  // Linear taper from 1.0 at day 7 down to 0.0 at day 30
  return 1 - (daysRemaining - 7) / (30 - 7);
}

/**
 * Recompute contributions_last_24h, unique_contributors_last_7d, and
 * trending_score for every active campaign, then persist the result.
 * Safe to call repeatedly (idempotent, single UPDATE pass).
 */
async function recomputeTrendingScores() {
  const { rows: campaigns } = await db.query(
    `SELECT
       c.id,
       c.raised_amount,
       c.target_amount,
       c.deadline,
       COALESCE(c24.count, 0)::int AS contributions_last_24h,
       COALESCE(c7.count, 0)::int AS unique_contributors_last_7d
     FROM campaigns c
     LEFT JOIN (
       SELECT campaign_id, COUNT(*)::int AS count
       FROM contributions
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY campaign_id
     ) c24 ON c24.campaign_id = c.id
     LEFT JOIN (
       SELECT campaign_id, COUNT(DISTINCT sender_public_key)::int AS count
       FROM contributions
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY campaign_id
     ) c7 ON c7.campaign_id = c.id
     WHERE c.deleted_at IS NULL
       AND c.is_hidden = FALSE
       AND c.is_flagged_duplicate = FALSE
       AND c.status = 'active'`
  );

  if (!campaigns.length) return { updated: 0 };

  const maxContributions24h = Math.max(1, ...campaigns.map(c => c.contributions_last_24h));
  const maxContributors7d = Math.max(1, ...campaigns.map(c => c.unique_contributors_last_7d));

  const now = Date.now();
  const values = [];
  const rows = campaigns.map((c, i) => {
    const percentFunded =
      c.target_amount > 0 ? Math.min(1, Number(c.raised_amount) / Number(c.target_amount)) : 0;
    const daysRemaining = c.deadline
      ? Math.ceil((new Date(c.deadline).getTime() - now) / (1000 * 60 * 60 * 24))
      : null;

    const score =
      (c.contributions_last_24h / maxContributions24h) * 40 +
      percentFunded * 30 +
      (c.unique_contributors_last_7d / maxContributors7d) * 20 +
      deadlineScore(daysRemaining) * 10;

    values.push(c.id, c.contributions_last_24h, c.unique_contributors_last_7d, score.toFixed(4));
    const base = i * 4;
    return `($${base + 1}::uuid, $${base + 2}::int, $${base + 3}::int, $${base + 4}::numeric)`;
  });

  await db.query(
    `UPDATE campaigns AS c
     SET contributions_last_24h = v.contributions_last_24h,
         unique_contributors_last_7d = v.unique_contributors_last_7d,
         trending_score = v.trending_score,
         trending_last_computed_at = NOW()
     FROM (VALUES ${rows.join(', ')})
       AS v(id, contributions_last_24h, unique_contributors_last_7d, trending_score)
     WHERE c.id = v.id`,
    values
  );

  trendingCache.invalidate(TRENDING_CACHE_KEY);
  logger.info('Trending scores recomputed', { campaigns_updated: campaigns.length });
  return { updated: campaigns.length };
}

/**
 * Top 20 campaigns by trending_score, served from the 15-minute cache.
 * Falls back to computing on first request if the cron hasn't run yet.
 */
async function getTrendingCampaigns({ limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);

  const rows = await trendingCache.wrap(
    TRENDING_CACHE_KEY,
    async () => {
      const { rows } = await db.query(
        `SELECT c.id, c.title, c.description, c.category, c.tags, c.asset_type,
              c.target_amount, c.raised_amount, c.status, c.deadline,
              c.contributions_last_24h, c.unique_contributors_last_7d,
              c.trending_score, c.trending_last_computed_at,
              u.name AS creator_name
       FROM campaigns c
       JOIN users u ON u.id = c.creator_id
       WHERE c.deleted_at IS NULL
         AND c.is_hidden = FALSE
         AND c.is_flagged_duplicate = FALSE
         AND c.status = 'active'
       ORDER BY c.trending_score DESC, c.created_at DESC
       LIMIT 50`
      );
      return rows;
    },
    TRENDING_CACHE_TTL_MS
  );

  return rows.slice(0, capped);
}

module.exports = {
  recomputeTrendingScores,
  getTrendingCampaigns,
  deadlineScore, // exported for unit tests
  TRENDING_CACHE_KEY,
};
