'use strict';

const db = require('../config/database');
const { TtlCache } = require('../utils/TtlCache');
const { evaluateBadges } = require('./badgeService');

// Cache per-user dashboard data for 60 seconds.
// Key scheme: "campaigns:<userId>" and "contributions:<userId>"
const dashboardCache = new TtlCache(60_000);

async function listCreatorCampaignsCached(userId) {
  const key = `campaigns:${userId}`;
  return dashboardCache.wrap(key, async () => {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.asset_type, c.target_amount, c.raised_amount,
              c.deadline, c.created_at,
              COALESCE(stats.contributor_count, 0) AS contributor_count,
              EXISTS (
                SELECT 1 FROM milestones m WHERE m.campaign_id = c.id LIMIT 1
              ) AS has_milestones
       FROM campaigns c
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT sender_public_key)::int AS contributor_count
         FROM contributions ctr
         WHERE ctr.campaign_id = c.id
       ) stats ON TRUE
       WHERE c.creator_id = $1
       ORDER BY c.created_at DESC`,
      [userId]
    );
    return rows;
  });
}

// Whitelisted columns for ?fields= on GET /campaigns/mine.
// Keeps SQL injection-safe field selection for lightweight consumers
// (e.g. NotificationSettings only needs id/title/status/raised_amount).
const CREATOR_CAMPAIGN_FIELDS = {
  id: 'c.id',
  title: 'c.title',
  status: 'c.status',
  asset_type: 'c.asset_type',
  target_amount: 'c.target_amount',
  raised_amount: 'c.raised_amount',
  deadline: 'c.deadline',
  created_at: 'c.created_at',
  is_hidden: 'c.is_hidden',
  contributor_count: 'COALESCE(stats.contributor_count, 0) AS contributor_count',
  has_milestones: `EXISTS (
              SELECT 1 FROM milestones m WHERE m.campaign_id = c.id LIMIT 1
            ) AS has_milestones`,
};

const DEFAULT_CREATOR_CAMPAIGN_FIELDS = [
  'id',
  'title',
  'status',
  'asset_type',
  'target_amount',
  'raised_amount',
  'deadline',
  'created_at',
  'is_hidden',
  'contributor_count',
  'has_milestones',
];

function parseCreatorCampaignFields(fieldsParam) {
  if (fieldsParam === undefined || fieldsParam === null || fieldsParam === '') {
    return DEFAULT_CREATOR_CAMPAIGN_FIELDS;
  }
  const requested = String(fieldsParam)
    .split(',')
    .map(f => f.trim())
    .filter(Boolean);
  const selected = [];
  for (const name of requested) {
    if (CREATOR_CAMPAIGN_FIELDS[name] && !selected.includes(name)) {
      selected.push(name);
    }
  }
  if (!selected.length) return DEFAULT_CREATOR_CAMPAIGN_FIELDS;
  // Always include id so clients can key list items.
  if (!selected.includes('id')) selected.unshift('id');
  return selected;
}

async function listCreatorCampaigns(userId, options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(options.limit, 10) || 20), 100);
  const offset = (page - 1) * limit;
  const selectedFields = parseCreatorCampaignFields(options.fields);
  const needsContributorCount = selectedFields.includes('contributor_count');
  const selectSql = selectedFields
    .map(name => CREATOR_CAMPAIGN_FIELDS[name])
    .join(',\n            ');
  const joinSql = needsContributorCount
    ? `LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT sender_public_key)::int AS contributor_count
       FROM contributions ctr
       WHERE ctr.campaign_id = c.id
     ) stats ON TRUE`
    : '';

  const countResult = await db.query(
    'SELECT COUNT(*)::int AS total FROM campaigns WHERE creator_id = $1',
    [userId]
  );
  const total = countResult.rows[0]?.total || 0;
  const totalPages = Math.ceil(total / limit);

  const { rows } = await db.query(
    `SELECT ${selectSql}
     FROM campaigns c
     ${joinSql}
     WHERE c.creator_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return {
    data: rows,
    pagination: { page, limit, total, totalPages },
  };
}

async function listUserContributions(userId) {
  const key = `contributions:${userId}`;
  return dashboardCache.wrap(key, async () => {
    const { rows: userRows } = await db.query('SELECT wallet_public_key FROM users WHERE id = $1', [
      userId,
    ]);
    if (!userRows.length) return null;

    const senderPublicKey = userRows[0].wallet_public_key;
    const { rows } = await db.query(
      `SELECT ctr.id, ctr.amount, ctr.asset, ctr.anchor_id, ctr.anchor_transaction_id,
              ctr.source_amount, ctr.source_asset, ctr.conversion_rate, ctr.payment_type,
              ctr.tx_hash, ctr.created_at,
              c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
              c.target_amount, c.raised_amount
       FROM contributions ctr
       JOIN campaigns c ON c.id = ctr.campaign_id
       WHERE ctr.sender_public_key = $1
       ORDER BY ctr.created_at DESC`,
      [senderPublicKey]
    );
    return rows;
  });
}

/**
 * Invalidate all cached dashboard data for a given user.
 * Call this after a contribution is made or a campaign status changes.
 * @param {string} userId
 */
function invalidateUserDashboard(userId) {
  dashboardCache.invalidatePrefix(`campaigns:${userId}`);
  dashboardCache.invalidatePrefix(`contributions:${userId}`);
}

const ACTIVE_CAMPAIGN_STATUSES = new Set(['active', 'funded']);
const COMPLETED_CAMPAIGN_STATUSES = new Set(['completed', 'funded', 'withdrawn']);

async function getContributorDashboard(userId) {
  const { rows: userRows } = await db.query('SELECT wallet_public_key FROM users WHERE id = $1', [
    userId,
  ]);
  if (!userRows.length) return null;

  const senderPublicKey = userRows[0].wallet_public_key;

  const { rows: contribs } = await db.query(
    `SELECT ctr.id, ctr.amount, ctr.asset, ctr.tx_hash, ctr.created_at,
            ctr.contract_refunded_at, ctr.contract_refund_tx_hash,
            c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
            c.target_amount, c.raised_amount, c.asset_type, c.deadline, c.escrow_contract_id
     FROM contributions ctr
     JOIN campaigns c ON c.id = ctr.campaign_id
     WHERE ctr.sender_public_key = $1
     ORDER BY ctr.created_at DESC`,
    [senderPublicKey]
  );

  if (!contribs.length) {
    const emptyStats = {
      total_contributed: 0,
      active_campaigns_backed: 0,
      total_refunded: 0,
      campaigns_backed: 0,
      campaigns_completed: 0,
      avg_contribution: 0,
    };
    return {
      stats: { ...emptyStats, badges: await evaluateBadges(userId) },
      campaigns: [],
    };
  }

  const campaignIds = [...new Set(contribs.map(row => row.campaign_id))];

  const { rows: milestones } = await db.query(
    `SELECT id, campaign_id, title, release_percentage, sort_order, status
     FROM milestones
     WHERE campaign_id = ANY($1::int[])
     ORDER BY campaign_id, sort_order ASC`,
    [campaignIds]
  );

  const milestonesByCampaign = {};
  for (const milestone of milestones) {
    if (!milestonesByCampaign[milestone.campaign_id]) {
      milestonesByCampaign[milestone.campaign_id] = [];
    }
    milestonesByCampaign[milestone.campaign_id].push({
      id: milestone.id,
      title: milestone.title,
      release_percentage: Number(milestone.release_percentage),
      status: milestone.status,
    });
  }

  const campaignsMap = new Map();
  let totalContributed = 0;
  let totalRefunded = 0;

  for (const row of contribs) {
    const amount = Number(row.amount);
    totalContributed += amount;
    if (row.contract_refunded_at) totalRefunded += amount;

    if (!campaignsMap.has(row.campaign_id)) {
      campaignsMap.set(row.campaign_id, {
        campaign_id: row.campaign_id,
        title: row.campaign_title,
        status: row.campaign_status,
        target_amount: Number(row.target_amount),
        raised_amount: Number(row.raised_amount),
        asset_type: row.asset_type,
        deadline: row.deadline,
        escrow_contract_id: row.escrow_contract_id,
        contributed_amount: 0,
        contributions: [],
        milestones: milestonesByCampaign[row.campaign_id] || [],
      });
    }

    const campaign = campaignsMap.get(row.campaign_id);
    campaign.contributed_amount += amount;
    campaign.contributions.push({
      id: row.id,
      amount,
      asset: row.asset,
      tx_hash: row.tx_hash,
      created_at: row.created_at,
      refund_status: row.contract_refunded_at
        ? 'processed'
        : row.campaign_status === 'failed'
          ? 'pending'
          : null,
      refund_tx_hash: row.contract_refund_tx_hash,
    });
  }

  const allCampaigns = [...campaignsMap.values()];
  const activeCampaignsBacked = allCampaigns.filter(campaign =>
    ACTIVE_CAMPAIGN_STATUSES.has(campaign.status)
  ).length;
  const campaignsCompleted = allCampaigns.filter(campaign =>
    COMPLETED_CAMPAIGN_STATUSES.has(campaign.status)
  ).length;

  const stats = {
    total_contributed: totalContributed,
    active_campaigns_backed: activeCampaignsBacked,
    total_refunded: totalRefunded,
    campaigns_backed: allCampaigns.length,
    campaigns_completed: campaignsCompleted,
    avg_contribution: contribs.length ? totalContributed / contribs.length : 0,
  };

  return {
    stats: { ...stats, badges: await evaluateBadges(userId) },
    campaigns: allCampaigns,
  };
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function getContributorDashboardCsv(userId) {
  const dashboard = await getContributorDashboard(userId);
  if (!dashboard) return null;

  const header = ['date', 'campaign', 'amount', 'asset', 'tx_hash', 'refund_status'];
  const rows = [header.join(',')];

  for (const campaign of dashboard.campaigns) {
    for (const contribution of campaign.contributions) {
      rows.push(
        [
          new Date(contribution.created_at).toISOString(),
          campaign.title,
          contribution.amount,
          contribution.asset,
          contribution.tx_hash || '',
          contribution.refund_status || '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  }

  return rows.join('\n');
}

module.exports = {
  listCreatorCampaigns,
  listUserContributions,
  invalidateUserDashboard,
  // Exported for testing
  _dashboardCache: dashboardCache,
  getContributorDashboard,
  getContributorDashboardCsv,
};
