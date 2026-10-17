'use strict';

const db = require('../config/database');
const { TtlCache } = require('../utils/TtlCache');
const logger = require('../config/logger');

const analyticsCache = new TtlCache(60 * 60_000);

const EXPORT_DAILY_LIMIT = 5;

const BRACKET_DEFS = [
  { bracket: 'small', min: 0, max: 5000 },
  { bracket: 'medium', min: 5000, max: 50000 },
  { bracket: 'large', min: 50000, max: Infinity },
];

function classifyBracket(amount) {
  for (const { bracket, min, max } of BRACKET_DEFS) {
    if (amount >= min && amount < max) return bracket;
  }
  return 'large';
}

async function verifyCreatorOwnsCampaign(creatorId, campaignId) {
  const { rows } = await db.query(
    'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2 AND deleted_at IS NULL',
    [campaignId, creatorId]
  );
  return rows.length > 0;
}

async function getCreatorOverview(creatorId) {
  const cacheKey = `overview:${creatorId}`;
  return analyticsCache.wrap(cacheKey, async () => {
    const [totals, bestCampaign, velocity7, velocity30] = await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(c.raised_amount), 0) AS total_raised,
           COUNT(DISTINCT ctr.sender_public_key)::int AS unique_contributors,
           COUNT(DISTINCT c.id)::int AS total_campaigns,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active')::int AS active_campaigns,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('completed','funded'))::int AS completed_campaigns,
           COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'failed')::int AS expired_campaigns,
           COALESCE(AVG(ctr.amount), 0) AS avg_contribution
         FROM campaigns c
         LEFT JOIN contributions ctr ON ctr.campaign_id = c.id
         WHERE c.creator_id = $1 AND c.deleted_at IS NULL`,
        [creatorId]
      ),
      db.query(
        `SELECT c.id, c.title, c.raised_amount, c.target_amount, c.asset_type,
                CASE WHEN c.target_amount > 0
                  THEN LEAST(100, ROUND((c.raised_amount / c.target_amount) * 100, 1))
                  ELSE 0
                END AS goal_pct
         FROM campaigns c
         WHERE c.creator_id = $1 AND c.deleted_at IS NULL AND c.target_amount > 0
         ORDER BY goal_pct DESC
         LIMIT 1`,
        [creatorId]
      ),
      db.query(
        `WITH daily AS (
           SELECT DATE(ctr.created_at) AS day, SUM(ctr.amount) AS daily_amount
           FROM contributions ctr
           JOIN campaigns c ON c.id = ctr.campaign_id
           WHERE c.creator_id = $1 AND c.deleted_at IS NULL
             AND ctr.created_at >= NOW() - INTERVAL '7 days'
           GROUP BY DATE(ctr.created_at)
         )
         SELECT COALESCE(AVG(daily_amount), 0) AS avg_7d
         FROM daily`,
        [creatorId]
      ),
      db.query(
        `WITH daily AS (
           SELECT DATE(ctr.created_at) AS day, SUM(ctr.amount) AS daily_amount
           FROM contributions ctr
           JOIN campaigns c ON c.id = ctr.campaign_id
           WHERE c.creator_id = $1 AND c.deleted_at IS NULL
             AND ctr.created_at >= NOW() - INTERVAL '30 days'
           GROUP BY DATE(ctr.created_at)
         )
         SELECT COALESCE(AVG(daily_amount), 0) AS avg_30d
         FROM daily`,
        [creatorId]
      ),
    ]);

    const row = totals.rows[0];
    const best = bestCampaign.rows[0] || null;

    return {
      total_raised: row.total_raised,
      unique_contributors: row.unique_contributors,
      total_campaigns: row.total_campaigns,
      active_campaigns: row.active_campaigns,
      completed_campaigns: row.completed_campaigns,
      expired_campaigns: row.expired_campaigns,
      best_performing_campaign: best,
      avg_contribution: row.avg_contribution,
      velocity_7d_avg: velocity7.rows[0]?.avg_7d || 0,
      velocity_30d_avg: velocity30.rows[0]?.avg_30d || 0,
      generated_at: new Date().toISOString(),
    };
  });
}

async function getCampaignDeepDive(creatorId, campaignId) {
  if (!(await verifyCreatorOwnsCampaign(creatorId, campaignId))) {
    return null;
  }

  const cacheKey = `campaign:${creatorId}:${campaignId}`;
  return analyticsCache.wrap(cacheKey, async () => {
    const [campaign, hourly, retention, assetMix, firstContrib, milestones] = await Promise.all([
      db.query(
        `SELECT id, title, raised_amount, target_amount, asset_type, status, created_at, deadline
         FROM campaigns WHERE id = $1`,
        [campaignId]
      ),
      db.query(
        `SELECT
           date_trunc('hour', created_at)::text AS hour,
           COUNT(*)::int AS contribution_count,
           COALESCE(SUM(amount), 0) AS total_amount
         FROM contributions
         WHERE campaign_id = $1
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY date_trunc('hour', created_at)
         ORDER BY hour ASC`,
        [campaignId]
      ),
      db.query(
        `SELECT
           sender_public_key,
           COUNT(*) AS times,
           MIN(created_at) AS first_contribution_at
         FROM contributions
         WHERE campaign_id = $1
         GROUP BY sender_public_key`,
        [campaignId]
      ),
      db.query(
        `SELECT COALESCE(source_asset, asset) AS asset,
                COUNT(*)::int AS count,
                COALESCE(SUM(amount), 0) AS total
         FROM contributions
         WHERE campaign_id = $1
         GROUP BY asset
         ORDER BY total DESC`,
        [campaignId]
      ),
      db.query(
        `SELECT MIN(created_at) AS first_contribution_at
         FROM contributions WHERE campaign_id = $1`,
        [campaignId]
      ),
      db.query(
        `SELECT title, release_percentage, sort_order, status
         FROM milestones
         WHERE campaign_id = $1
         ORDER BY sort_order ASC`,
        [campaignId]
      ),
    ]);

    if (!campaign.rows.length) return null;
    const c = campaign.rows[0];

    const contributorRows = retention.rows;
    const returning = contributorRows.filter(r => r.times > 1).length;
    const newCount = contributorRows.filter(r => r.times === 1).length;

    const firstContribTime = firstContrib.rows[0]?.first_contribution_at;
    const launchTime = c.created_at;
    let medianTimeToFirstContribHours = null;
    if (firstContribTime && launchTime) {
      const diffMs = new Date(firstContribTime).getTime() - new Date(launchTime).getTime();
      medianTimeToFirstContribHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
    }

    const target = Number(c.target_amount) || 0;
    const raised = Number(c.raised_amount) || 0;
    const milestoneThresholds = milestones.rows.map(m => ({
      title: m.title,
      percentage: Number(m.release_percentage),
      status: m.status,
    }));

    const milestonesWithProgress = milestoneThresholds.map(m => {
      const threshold = (m.percentage / 100) * target;
      const pct = target > 0 ? Math.min(100, (raised / threshold) * 100) : 0;
      return { ...m, progress_pct: Math.round(pct * 10) / 10 };
    });

    return {
      campaign: {
        id: c.id,
        title: c.title,
        raised_amount: c.raised_amount,
        target_amount: c.target_amount,
        asset_type: c.asset_type,
        status: c.status,
        created_at: c.created_at,
        deadline: c.deadline,
      },
      hourly_trend: hourly.rows,
      contributor_retention: {
        returning: returning,
        new: newCount,
        total: returning + newCount,
        retention_rate:
          contributorRows.length > 0
            ? Math.round((returning / contributorRows.length) * 10000) / 100
            : 0,
      },
      asset_mix: assetMix.rows,
      median_time_to_first_contribution_hours: medianTimeToFirstContribHours,
      milestones: milestonesWithProgress,
      generated_at: new Date().toISOString(),
    };
  });
}

async function getBenchmarks(creatorId) {
  const cacheKey = `benchmarks:${creatorId}`;
  return analyticsCache.wrap(cacheKey, async () => {
    const { rows: creatorCampaigns } = await db.query(
      `SELECT c.id, c.target_amount, c.asset_type, c.created_at,
              COALESCE(ctr.total_raised, 0) AS total_raised,
              COALESCE(ctr.contributor_count, 0) AS contributor_count,
              ctr.first_contribution_at
       FROM campaigns c
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS total_raised,
                COUNT(DISTINCT sender_public_key) AS contributor_count,
                MIN(created_at) AS first_contribution_at
         FROM contributions WHERE campaign_id = c.id
       ) ctr ON TRUE
       WHERE c.creator_id = $1 AND c.deleted_at IS NULL AND c.target_amount > 0`,
      [creatorId]
    );

    const { rows: platformBenchmarks } = await db.query(
      `SELECT bracket, asset, avg_goal_pct, avg_time_to_first_contribution_hours,
              avg_contributor_count, sample_size
       FROM platform_benchmarks
       WHERE sample_size >= 10
       ORDER BY bracket, asset`
    );

    const benchmarksByBracket = {};
    for (const b of platformBenchmarks) {
      const key = `${b.bracket}_${b.asset}`;
      benchmarksByBracket[key] = b;
    }

    const comparisons = creatorCampaigns.map(campaign => {
      const bracket = classifyBracket(Number(campaign.target_amount));
      const key = `${bracket}_${campaign.asset_type}`;
      const platform = benchmarksByBracket[key] || null;

      const launchTs = new Date(campaign.created_at).getTime();
      const firstContribTs = campaign.first_contribution_at
        ? new Date(campaign.first_contribution_at).getTime()
        : null;
      const timeToFirstHours =
        firstContribTs !== null
          ? Math.round(((firstContribTs - launchTs) / (1000 * 60 * 60)) * 100) / 100
          : null;

      const goalPct =
        Number(campaign.target_amount) > 0
          ? Math.round((Number(campaign.total_raised) / Number(campaign.target_amount)) * 10000) /
            100
          : 0;

      return {
        campaign_id: campaign.id,
        bracket,
        asset: campaign.asset_type,
        creator: {
          goal_pct: goalPct,
          time_to_first_contribution_hours: timeToFirstHours,
          contributor_count: campaign.contributor_count,
        },
        platform: platform
          ? {
              avg_goal_pct: platform.avg_goal_pct,
              avg_time_to_first_contribution_hours: platform.avg_time_to_first_contribution_hours,
              avg_contributor_count: platform.avg_contributor_count,
              sample_size: platform.sample_size,
            }
          : null,
      };
    });

    return {
      comparisons,
      generated_at: new Date().toISOString(),
    };
  });
}

async function checkExportRateLimit(creatorId) {
  const { rows } = await db.query(
    `SELECT export_count FROM creator_export_rate_limits
     WHERE creator_id = $1 AND export_date = CURRENT_DATE`,
    [creatorId]
  );
  if (rows.length === 0) return { allowed: true, remaining: EXPORT_DAILY_LIMIT };
  const count = rows[0].export_count;
  return {
    allowed: count < EXPORT_DAILY_LIMIT,
    remaining: Math.max(0, EXPORT_DAILY_LIMIT - count),
  };
}

async function incrementExportCount(creatorId) {
  await db.query(
    `INSERT INTO creator_export_rate_limits (creator_id, export_date, export_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (creator_id, export_date)
     DO UPDATE SET export_count = creator_export_rate_limits.export_count + 1`,
    [creatorId]
  );
}

async function getExportData(creatorId, campaignId) {
  if (!(await verifyCreatorOwnsCampaign(creatorId, campaignId))) {
    return null;
  }

  const { rows } = await db.query(
    `SELECT
       ctr.created_at AS contribution_date,
       ctr.sender_public_key,
       ctr.amount,
       ctr.asset,
       ctr.source_asset,
       ctr.source_amount,
       ctr.tx_hash,
       ctr.referral_code
     FROM contributions ctr
     WHERE ctr.campaign_id = $1
     ORDER BY ctr.created_at ASC`,
    [campaignId]
  );

  return rows.map(r => ({
    contribution_date: r.contribution_date,
    contributor_public_key: truncatePublicKey(r.sender_public_key),
    amount: r.amount,
    asset: r.asset,
    source_asset: r.source_asset,
    source_amount: r.source_amount,
    usd_equivalent: r.asset === 'USDC' ? r.amount : null,
    stellar_tx_hash: r.tx_hash,
    referral_code: r.referral_code || '',
  }));
}

function truncatePublicKey(key) {
  if (!key || key.length < 12) return key || '';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

async function getExportRowCount(creatorId, campaignId) {
  if (!(await verifyCreatorOwnsCampaign(creatorId, campaignId))) return -1;
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS total FROM contributions WHERE campaign_id = $1',
    [campaignId]
  );
  return rows[0]?.total || 0;
}

async function refreshPlatformBenchmarks() {
  logger.info('[creatorAnalytics] refreshing platform benchmarks');

  for (const { bracket, min, max } of BRACKET_DEFS) {
    const { rows: assets } = await db.query(
      `SELECT DISTINCT asset_type FROM campaigns WHERE deleted_at IS NULL AND target_amount > 0`
    );

    for (const { asset_type } of assets) {
      const targetFilter =
        max === Infinity
          ? `c.target_amount >= ${min} AND c.asset_type = $1`
          : `c.target_amount >= ${min} AND c.target_amount < ${max} AND c.asset_type = $1`;

      const { rows: stats } = await db.query(
        `SELECT
           COUNT(DISTINCT c.id)::int AS sample_size,
           ROUND(AVG(
             CASE WHEN c.target_amount > 0
               THEN LEAST(100, (c.raised_amount / c.target_amount) * 100)
               ELSE 0
             END
           ), 2) AS avg_goal_pct,
           ROUND(AVG(
             EXTRACT(EPOCH FROM (first_contrib.first_contribution_at - c.created_at)) / 3600
           ), 2) AS avg_time_to_first_contribution_hours,
           ROUND(AVG(COALESCE(contrib.contributor_count, 0)), 2) AS avg_contributor_count
         FROM campaigns c
         LEFT JOIN LATERAL (
           SELECT MIN(created_at) AS first_contribution_at
           FROM contributions WHERE campaign_id = c.id
         ) first_contrib ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT sender_public_key) AS contributor_count
           FROM contributions WHERE campaign_id = c.id
         ) contrib ON TRUE
         WHERE ${targetFilter}`,
        [asset_type]
      );

      const s = stats.rows[0];
      if (s.sample_size >= 10) {
        await db.query(
          `INSERT INTO platform_benchmarks (bracket, asset, avg_goal_pct, avg_time_to_first_contribution_hours, avg_contributor_count, sample_size, computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (bracket, asset)
           DO UPDATE SET
             avg_goal_pct = EXCLUDED.avg_goal_pct,
             avg_time_to_first_contribution_hours = EXCLUDED.avg_time_to_first_contribution_hours,
             avg_contributor_count = EXCLUDED.avg_contributor_count,
             sample_size = EXCLUDED.sample_size,
             computed_at = NOW()`,
          [
            bracket,
            asset_type,
            s.avg_goal_pct,
            s.avg_time_to_first_contribution_hours,
            s.avg_contributor_count,
            s.sample_size,
          ]
        );
      }
    }
  }

  analyticsCache.invalidatePrefix('benchmarks:');
  logger.info('[creatorAnalytics] platform benchmarks refreshed');
}

module.exports = {
  getCreatorOverview,
  getCampaignDeepDive,
  getBenchmarks,
  getExportData,
  getExportRowCount,
  checkExportRateLimit,
  incrementExportCount,
  refreshPlatformBenchmarks,
  classifyBracket,
  EXPORT_DAILY_LIMIT,
};
