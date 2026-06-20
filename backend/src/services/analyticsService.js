const db = require('../config/database');

/**
 * Daily contribution buckets for the full campaign duration.
 * Fills in zero-contribution days so charts render continuous lines.
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
              COALESCE(AVG(amount), 0)                AS avg_contribution
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

  // Fill zero-contribution days across the full campaign duration
  const start = new Date(campaign.created_at);
  const end = campaign.deadline ? new Date(campaign.deadline) : new Date();
  const byDay = Object.fromEntries(dailyRows.rows.map(r => [r.day.toISOString().slice(0, 10), r]));
  const buckets = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
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

/**
 * Aggregate analytics across all campaigns owned by a creator.
 */
async function getUserDashboardAnalytics(userId) {
  const [overviewRows, trendRows, topCampaignRows] = await Promise.all([
    db.query(
      `SELECT
         COUNT(DISTINCT c.id)::int                                AS total_campaigns,
         COALESCE(SUM(ctr.amount), 0)                            AS total_raised,
         COUNT(ctr.id)::int                                       AS total_contributions,
         COUNT(DISTINCT ctr.sender_public_key)::int              AS unique_contributors,
         COALESCE(AVG(ctr.amount), 0)                            AS avg_contribution
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
  ]);

  return {
    overview: overviewRows.rows[0],
    recent_trend: trendRows.rows,
    top_campaigns: topCampaignRows.rows,
  };
}

module.exports = { getCampaignAnalytics, getCampaignContributors, getUserDashboardAnalytics };
