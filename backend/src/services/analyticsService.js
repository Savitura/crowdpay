'use strict';

/**
 * analyticsService.js
 *
 * Provides campaign analytics data. All query results are cached for 5 minutes
 * since analytics data changes infrequently and these 4 queries are expensive
 * (aggregations over contributions, campaigns, and milestones).
 *
 * Cache key scheme: "analytics:<campaignId>"
 * Invalidation: call invalidateCampaignAnalytics(campaignId) after a
 *               contribution is recorded or a milestone is released.
 */

const db = require('../config/database');
const { TtlCache } = require('../utils/TtlCache');

// 5-minute TTL — analytics snapshots don't need sub-minute freshness
const analyticsCache = new TtlCache(5 * 60_000);

/**
 * Maximum number of daily buckets returned by getCampaignAnalytics.
 * A campaign running longer than 365 days will have its time range clamped
 * to the most recent 365 days. The response includes the effective range used.
 */
const MAX_DAILY_BUCKETS = 365;

/**
 * Get analytics for a single campaign.
 *
 * Runs 4 parallel queries:
 *   1. Contribution totals and unique backer count
 *   2. Daily contribution time series (bounded by MAX_DAILY_BUCKETS days)
 *   3. Milestone release summary
 *   4. Asset / payment-type breakdown
 *
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
async function getCampaignAnalytics(campaignId) {
  const { rows: [campaign] } = await db.query(
    `SELECT created_at, deadline, raised_amount, target_amount, asset_type FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!campaign) return null;

  const [dailyRows, summaryRows, assetRows] = await Promise.all([
    db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*)::int     AS contribution_count,
              SUM(amount)       AS total_amount
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT COUNT(*)::int                           AS total_contributions,
              COUNT(DISTINCT sender_public_key)::int  AS unique_contributors,
              COALESCE(AVG(amount), 0)                AS avg_contribution,
              SUM(CASE WHEN is_recurring = TRUE THEN 1 ELSE 0 END)::int AS recurring_contributions,
              COALESCE(SUM(amount) FILTER (WHERE is_recurring = TRUE), 0) AS recurring_total
       FROM contributions
       WHERE campaign_id = $1`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(source_asset, asset) AS currency,
              COUNT(*)::int                  AS count,
              SUM(amount)                    AS total
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY currency
       ORDER BY total DESC`,
      [campaignId]
    ),
  ]);

  // Fill zero-contribution days across the campaign duration, bounded by MAX_DAILY_BUCKETS
  const start = new Date(campaign.created_at);
  const end = campaign.deadline ? new Date(campaign.deadline) : new Date();
  const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  // If the campaign spans more than MAX_DAILY_BUCKETS days, clamp to the most recent window
  const effectiveStart = totalDays > MAX_DAILY_BUCKETS
    ? new Date(end.getTime() - (MAX_DAILY_BUCKETS - 1) * 24 * 60 * 60 * 1000)
    : start;

  const byDay = Object.fromEntries(dailyRows.rows.map(r => [r.day.toISOString().slice(0, 10), r]));
  const buckets = [];
  for (let d = new Date(effectiveStart); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    buckets.push(byDay[key] ?? { day: key, contribution_count: 0, total_amount: '0' });
  }

  return {
    campaign: {
      raised_amount: campaign.raised_amount,
      target_amount: campaign.target_amount,
      asset_type: campaign.asset_type,
    },
    summary: summaryRows.rows[0],
    daily_buckets: buckets,
    daily_buckets_meta: {
      max_buckets: MAX_DAILY_BUCKETS,
      range_clamped: totalDays > MAX_DAILY_BUCKETS,
      effective_start: effectiveStart.toISOString().slice(0, 10),
      effective_end: end.toISOString().slice(0, 10),
    },
    top_currencies: assetRows.rows,
  };
}

/**
 * Contributor breakdown: repeat vs first-time, country from user profile.
 */
async function getCampaignContributors(campaignId) {
  const [repeatRows, countryRows] = await Promise.all([
    db.query(
      `SELECT
         SUM(CASE WHEN times > 1 THEN 1 ELSE 0 END)::int AS repeat_contributors,
         SUM(CASE WHEN times = 1 THEN 1 ELSE 0 END)::int AS first_time_contributors
       FROM (
         SELECT sender_public_key, COUNT(*) AS times
         FROM contributions
         WHERE campaign_id = $1
         GROUP BY sender_public_key
       ) sub`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(u.country, 'Unknown') AS country,
              COUNT(DISTINCT ctr.sender_public_key)::int AS contributor_count
       FROM contributions ctr
       LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
       WHERE ctr.campaign_id = $1
       GROUP BY country
       ORDER BY contributor_count DESC
       LIMIT 10`,
      [campaignId]
    ),
  ]);

  return {
    ...repeatRows.rows[0],
    country_breakdown: countryRows.rows,
  };
}

async function getCampaignBackers(campaignId) {
  const [backerRows, topBackerRows, senderStats] = await Promise.all([
    db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(DISTINCT sender_public_key)::int AS new_backers
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT sender_public_key,
              COUNT(*)::int AS contribution_count,
              SUM(amount) AS total_amount
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY sender_public_key
       ORDER BY total_amount DESC, contribution_count DESC
       LIMIT 10`,
      [campaignId]
    ),
    // Compute sender stats once (total backers + repeat rate) to avoid duplicate subqueries
    db.query(
      `SELECT
         COUNT(DISTINCT sender_public_key)::int AS total_backers,
         CASE
           WHEN COUNT(*) = 0 THEN 0
           ELSE ROUND(
             SUM(CASE WHEN times > 1 THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100,
             2
           )
         END AS repeat_rate
       FROM (
         SELECT sender_public_key, COUNT(*) AS times
         FROM contributions
         WHERE campaign_id = $1
         GROUP BY sender_public_key
       ) sub`,
      [campaignId]
    ),
  ]);

  return {
    total_backers: senderStats.rows[0]?.total_backers ?? 0,
    new_backers_by_day: backerRows.rows,
    top_backers: topBackerRows.rows.map((row) => ({
      sender_public_key: row.sender_public_key,
      contribution_count: row.contribution_count,
      total_amount: row.total_amount,
    })),
    repeat_rate: Number(senderStats.rows[0]?.repeat_rate ?? 0),
  };
}

/**
 * Aggregate analytics across all campaigns owned by a creator.
 */
async function getUserDashboardAnalytics(userId) {
  const [overviewRows, trendRows, topCampaignRows, velocityRows, retentionRows, referralRows] = await Promise.all([
    db.query(
      `SELECT
         COUNT(DISTINCT c.id)::int                                AS total_campaigns,
         COALESCE(SUM(ctr.amount), 0)                            AS total_raised,
         COUNT(ctr.id)::int                                       AS total_contributions,
         COUNT(DISTINCT ctr.sender_public_key)::int              AS unique_contributors,
         COALESCE(AVG(ctr.amount), 0)                            AS avg_contribution,
         SUM(CASE WHEN ctr.is_recurring = TRUE THEN 1 ELSE 0 END)::int AS recurring_contributions,
         COALESCE(SUM(ctr.amount) FILTER (WHERE ctr.is_recurring = TRUE), 0) AS recurring_raised
       FROM campaigns c
       LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
       WHERE c.creator_id = $1`,
      [userId]
    ),
    db.query(
      `SELECT DATE(ctr.created_at) AS day,
              COUNT(*)::int         AS contribution_count,
              SUM(ctr.amount)       AS total_amount
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       WHERE c.creator_id = $1
         AND ctr.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(ctr.created_at)
       ORDER BY day ASC`,
      [userId]
    ),
    db.query(
      `SELECT c.id, c.title, c.raised_amount, c.target_amount, c.asset_type,
              COUNT(ctr.id)::int AS contribution_count
       FROM campaigns c
       LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
       WHERE c.creator_id = $1
       GROUP BY c.id
       ORDER BY c.raised_amount DESC
       LIMIT 5`,
      [userId]
    ),
    // Funding velocity: daily cumulative raised per campaign (last 60 days)
    db.query(
      `SELECT c.id AS campaign_id, c.title,
              DATE(ctr.created_at) AS day,
              SUM(ctr.amount)      AS daily_amount
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       WHERE c.creator_id = $1
         AND ctr.created_at >= NOW() - INTERVAL '60 days'
       GROUP BY c.id, c.title, DATE(ctr.created_at)
       ORDER BY c.id, day ASC`,
      [userId]
    ),
    // Contributor retention: returning vs first-time per month (last 6 months)
    db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', ctr.created_at), 'YYYY-MM') AS month,
         SUM(CASE WHEN prev.sender_public_key IS NOT NULL THEN 1 ELSE 0 END)::int AS returning_count,
         SUM(CASE WHEN prev.sender_public_key IS NULL    THEN 1 ELSE 0 END)::int AS new_count
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       LEFT JOIN (
         SELECT DISTINCT ctr2.sender_public_key
         FROM contributions ctr2
         JOIN campaigns c2 ON c2.id = ctr2.campaign_id
         WHERE c2.creator_id = $1
           AND ctr2.created_at < NOW() - INTERVAL '6 months'
       ) prev ON prev.sender_public_key = ctr.sender_public_key
       WHERE c.creator_id = $1
         AND ctr.created_at >= NOW() - INTERVAL '6 months'
       GROUP BY DATE_TRUNC('month', ctr.created_at)
       ORDER BY month ASC`,
      [userId]
    ),
    // Referral conversion rate: clicks vs contributions per referral code
    db.query(
      `SELECT
         cr.referral_code,
         COUNT(DISTINCT cr.id)::int  AS click_count,
         COUNT(DISTINCT ctr.id)::int AS contribution_count,
         CASE WHEN COUNT(cr.id) = 0 THEN 0
              ELSE ROUND(COUNT(DISTINCT ctr.id)::numeric / COUNT(cr.id) * 100, 2)
         END AS conversion_rate
       FROM campaign_referrals cr
       JOIN campaigns c ON c.id = cr.campaign_id
       LEFT JOIN contributions ctr ON ctr.referral_code = cr.referral_code
       WHERE c.creator_id = $1
       GROUP BY cr.referral_code
       ORDER BY contribution_count DESC
       LIMIT 10`,
      [userId]
    ),
  ]);

  return {
    overview: overviewRows.rows[0],
    recent_trend: trendRows.rows,
    top_campaigns: topCampaignRows.rows,
    funding_velocity: velocityRows.rows,
    contributor_retention: retentionRows.rows,
    referral_conversion: referralRows.rows,
  };
}

module.exports = {
  getCampaignAnalytics,
  getCampaignContributors,
  getCampaignBackers,
  getUserDashboardAnalytics,
  _analyticsCache: analyticsCache,
};