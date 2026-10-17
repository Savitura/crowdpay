const db = require('../config/database');
const logger = require('../config/logger');
const { createNotification } = require('./notifications');

// Contributor badges and leaderboard (#597).
//
// Badge criteria are evaluated from contribution history on demand. Earned
// badges are also written to `contributor_badges` so each one is announced to
// the contributor exactly once, no matter how often the dashboard reloads.

const EARLY_BACKER_RANK = 10;
const HIGH_VALUE_CONTRIBUTION = 500;

const COMPLETED_CAMPAIGN_STATUSES = ['completed', 'funded', 'withdrawn'];

const BADGE_DEFINITIONS = [
  {
    id: 'first_contribution',
    label: 'First contribution',
    description: 'Backed your first campaign.',
    earned: stats => stats.campaigns_backed >= 1,
  },
  {
    id: 'backed_5_campaigns',
    label: 'Backed 5 campaigns',
    description: 'Backed five different campaigns.',
    earned: stats => stats.campaigns_backed >= 5,
  },
  {
    id: 'backed_10_campaigns',
    label: 'Backed 10 campaigns',
    description: 'Backed ten different campaigns.',
    earned: stats => stats.campaigns_backed >= 10,
  },
  {
    id: 'contributed_1000',
    label: 'Contributed 1,000+',
    description: 'Contributed 1,000 or more across all campaigns.',
    earned: stats => stats.total_contributed >= 1000,
  },
  {
    id: 'backed_completed_campaign',
    label: 'Backed a completed campaign',
    description: 'Backed a campaign that reached its goal.',
    earned: stats => stats.campaigns_completed >= 1,
  },
  {
    id: 'early_backer',
    label: 'Early backer',
    description: `Among the first ${EARLY_BACKER_RANK} backers of a campaign.`,
    earned: stats => stats.early_backings >= 1,
  },
  {
    id: 'high_value_backer',
    label: 'High-value backer',
    description: `Made a single contribution of ${HIGH_VALUE_CONTRIBUTION.toLocaleString()} or more.`,
    earned: stats => stats.largest_contribution >= HIGH_VALUE_CONTRIBUTION,
  },
  {
    id: 'milestone_witness',
    label: 'Milestone witness',
    description: 'Backed a campaign that has released a milestone.',
    earned: stats => stats.campaigns_with_released_milestone >= 1,
  },
];

const EMPTY_STATS = {
  campaigns_backed: 0,
  contribution_count: 0,
  total_contributed: 0,
  largest_contribution: 0,
  early_backings: 0,
  campaigns_completed: 0,
  campaigns_with_released_milestone: 0,
};

/**
 * Aggregate everything the badge criteria need for one contributor.
 */
async function getContributorBadgeStats(userId) {
  const { rows: contributionRows } = await db.query(
    `WITH backer AS (
       SELECT wallet_public_key AS key FROM users WHERE id = $1
     ),
     my_contributions AS (
       SELECT ctr.id, ctr.campaign_id, ctr.amount, ctr.created_at
       FROM contributions ctr, backer
       WHERE ctr.sender_public_key = backer.key
     ),
     ranked AS (
       SELECT mc.id,
              (SELECT COUNT(*)
               FROM contributions earlier
               WHERE earlier.campaign_id = mc.campaign_id
                 AND earlier.created_at < mc.created_at) AS earlier_count
       FROM my_contributions mc
     )
     SELECT
       (SELECT COUNT(DISTINCT campaign_id) FROM my_contributions)::int AS campaigns_backed,
       (SELECT COUNT(*) FROM my_contributions)::int AS contribution_count,
       (SELECT COALESCE(SUM(amount), 0) FROM my_contributions) AS total_contributed,
       (SELECT COALESCE(MAX(amount), 0) FROM my_contributions) AS largest_contribution,
       (SELECT COUNT(*) FROM ranked WHERE earlier_count < $2)::int AS early_backings`,
    [userId, EARLY_BACKER_RANK]
  );

  const { rows: campaignRows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE c.status = ANY($2::text[]))::int AS campaigns_completed,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM milestones m WHERE m.campaign_id = c.id AND m.status = 'released'
         )
       )::int AS campaigns_with_released_milestone
     FROM campaigns c
     WHERE c.id IN (
       SELECT ctr.campaign_id
       FROM contributions ctr
       JOIN users u ON u.wallet_public_key = ctr.sender_public_key
       WHERE u.id = $1
     )`,
    [userId, COMPLETED_CAMPAIGN_STATUSES]
  );

  return {
    ...EMPTY_STATS,
    ...contributionRows[0],
    ...campaignRows[0],
    total_contributed: Number(contributionRows[0]?.total_contributed || 0),
    largest_contribution: Number(contributionRows[0]?.largest_contribution || 0),
  };
}

function computeBadges(stats, earnedAtById = {}) {
  return BADGE_DEFINITIONS.map(definition => ({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    earned: definition.earned(stats),
    earned_at: earnedAtById[definition.id] || null,
  }));
}

async function loadEarnedBadges(userId) {
  const { rows } = await db.query(
    'SELECT badge_id, earned_at FROM contributor_badges WHERE user_id = $1',
    [userId]
  );
  const byId = {};
  for (const row of rows) byId[row.badge_id] = row.earned_at;
  return byId;
}

/**
 * Persist any badge the contributor has newly qualified for and notify them
 * about it. Returns the ids that were recorded for the first time.
 */
async function recordEarnedBadges(userId, badges) {
  const newlyEarned = [];

  for (const badge of badges.filter(entry => entry.earned && !entry.earned_at)) {
    const { rows } = await db.query(
      `INSERT INTO contributor_badges (user_id, badge_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, badge_id) DO NOTHING
       RETURNING earned_at`,
      [userId, badge.id]
    );
    if (!rows.length) continue;

    badge.earned_at = rows[0].earned_at;
    newlyEarned.push(badge.id);

    try {
      await createNotification(userId, {
        type: 'badge_earned',
        title: `Badge earned: ${badge.label}`,
        body: badge.description,
        link: '/profile',
      });
    } catch (err) {
      logger.error('Badge notification failed', {
        user_id: userId,
        badge_id: badge.id,
        error: err.message,
      });
    }
  }

  return newlyEarned;
}

/**
 * Evaluate every badge for a contributor, recording and announcing the ones
 * they have just earned.
 */
async function evaluateBadges(userId) {
  const [stats, earnedAtById] = await Promise.all([
    getContributorBadgeStats(userId),
    loadEarnedBadges(userId),
  ]);

  const badges = computeBadges(stats, earnedAtById);
  await recordEarnedBadges(userId, badges);
  return badges;
}

/**
 * Same as evaluateBadges but never throws — for call sites (such as ledger
 * indexing) where badge bookkeeping must not break the primary flow.
 */
async function syncBadgesForContributor(userId) {
  try {
    return await evaluateBadges(userId);
  } catch (err) {
    logger.error('Badge sync failed', { user_id: userId, error: err.message });
    return [];
  }
}

async function syncBadgesForWallet(walletPublicKey) {
  const { rows } = await db.query('SELECT id FROM users WHERE wallet_public_key = $1', [
    walletPublicKey,
  ]);
  if (!rows.length) return [];
  return syncBadgesForContributor(rows[0].id);
}

/**
 * Public contributor leaderboard, ranked by total contributed.
 */
async function getLeaderboard({ limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);

  const { rows } = await db.query(
    `SELECT u.id, u.name,
            COALESCE(SUM(ctr.amount), 0) AS total_contributed,
            COUNT(DISTINCT ctr.campaign_id)::int AS campaigns_backed,
            (SELECT COUNT(*)::int FROM contributor_badges b WHERE b.user_id = u.id) AS badge_count
     FROM users u
     JOIN contributions ctr ON ctr.sender_public_key = u.wallet_public_key
     GROUP BY u.id, u.name
     ORDER BY total_contributed DESC, campaigns_backed DESC, u.name ASC
     LIMIT $1`,
    [safeLimit]
  );

  return rows.map((row, index) => ({
    rank: index + 1,
    user_id: row.id,
    name: row.name,
    total_contributed: Number(row.total_contributed),
    campaigns_backed: row.campaigns_backed,
    badge_count: row.badge_count,
  }));
}

module.exports = {
  BADGE_DEFINITIONS,
  computeBadges,
  getContributorBadgeStats,
  evaluateBadges,
  syncBadgesForContributor,
  syncBadgesForWallet,
  getLeaderboard,
};
