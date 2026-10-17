const db = require('../config/database');
const logger = require('../config/logger');
const { createNotificationsBulk } = require('./notifications');

// Campaign follow/watch (#592). Followers are users who want updates about a
// campaign without necessarily contributing to it. Each follow row carries its
// own notification preferences so a follower can, for example, hear about
// milestone releases but not every funding threshold.
//
// #961 adds a third, campaign-scoped layer: a contributor can mute a channel
// for a campaign they are not even following (see communicationPreferenceService).
// The per-campaign mute is the strongest signal and is applied here so every
// follower fan-out route respects it.
const PREFERENCE_COLUMNS = ['notify_updates', 'notify_milestones', 'notify_funding'];

/** Maps a follower preference column onto a per-campaign communication channel. */
const CHANNEL_FOR_PREFERENCE = {
  notify_updates: 'updates',
  notify_milestones: 'milestones',
  notify_funding: 'funding_updates',
};

// Percentages of the funding goal that are worth telling followers about.
const FUNDING_THRESHOLDS = [25, 50, 75, 100];

function pickPreferences(input = {}) {
  const prefs = {};
  for (const column of PREFERENCE_COLUMNS) {
    if (typeof input[column] === 'boolean') prefs[column] = input[column];
  }
  return prefs;
}

async function followCampaign(userId, campaignId, input = {}) {
  const prefs = pickPreferences(input);
  const columns = ['user_id', 'campaign_id', ...Object.keys(prefs)];
  const values = [userId, campaignId, ...Object.values(prefs)];
  const placeholders = values.map((_value, index) => `$${index + 1}`);

  // Re-following only rewrites the preferences the caller actually sent, so a
  // bare follow never clobbers choices the user made earlier.
  const conflictAction = Object.keys(prefs).length
    ? `DO UPDATE SET ${Object.keys(prefs)
        .map(column => `${column} = EXCLUDED.${column}`)
        .join(', ')}`
    : 'DO UPDATE SET user_id = campaign_followers.user_id';

  const { rows } = await db.query(
    `INSERT INTO campaign_followers (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (user_id, campaign_id) ${conflictAction}
     RETURNING campaign_id, notify_updates, notify_milestones, notify_funding, created_at`,
    values
  );
  return { following: true, ...rows[0] };
}

async function unfollowCampaign(userId, campaignId) {
  const { rowCount } = await db.query(
    'DELETE FROM campaign_followers WHERE user_id = $1 AND campaign_id = $2',
    [userId, campaignId]
  );
  return rowCount > 0;
}

async function updateFollowPreferences(userId, campaignId, input = {}) {
  const prefs = pickPreferences(input);
  if (!Object.keys(prefs).length) return null;

  const assignments = Object.keys(prefs).map((column, index) => `${column} = $${index + 3}`);
  const { rows } = await db.query(
    `UPDATE campaign_followers
     SET ${assignments.join(', ')}
     WHERE user_id = $1 AND campaign_id = $2
     RETURNING campaign_id, notify_updates, notify_milestones, notify_funding, created_at`,
    [userId, campaignId, ...Object.values(prefs)]
  );
  if (!rows.length) return null;
  return { following: true, ...rows[0] };
}

async function getFollowState(userId, campaignId) {
  const { rows } = await db.query(
    `SELECT campaign_id, notify_updates, notify_milestones, notify_funding, created_at
     FROM campaign_followers
     WHERE user_id = $1 AND campaign_id = $2`,
    [userId, campaignId]
  );
  if (!rows.length) {
    return {
      following: false,
      notify_updates: true,
      notify_milestones: true,
      notify_funding: true,
    };
  }
  return { following: true, ...rows[0] };
}

async function countFollowers(campaignId) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS total FROM campaign_followers WHERE campaign_id = $1',
    [campaignId]
  );
  return rows[0]?.total || 0;
}

async function listFollowedCampaigns(userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.status, c.asset_type, c.target_amount, c.raised_amount, c.deadline,
            f.notify_updates, f.notify_milestones, f.notify_funding,
            f.created_at AS followed_at
     FROM campaign_followers f
     JOIN campaigns c ON c.id = f.campaign_id
     WHERE f.user_id = $1 AND c.deleted_at IS NULL
     ORDER BY f.created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Fan a campaign event out to its followers.
 *
 * @param {string} campaignId
 * @param {'notify_updates'|'notify_milestones'|'notify_funding'} preference
 *   Follow-row column that gates this event.
 * @param {{type: string, title: string, body?: string, link?: string}} message
 * @param {string|string[]} [exclude] Users already notified through another
 *   path (the actor, or contributors who get their own alert).
 * @returns {Promise<number>} number of followers notified
 */
async function notifyFollowers(campaignId, preference, message, exclude) {
  if (!PREFERENCE_COLUMNS.includes(preference)) {
    throw new Error(`Unknown follower notification preference: ${preference}`);
  }

  const excluded = (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean);
  const { rows: followers } = await db.query(
    `SELECT f.user_id
     FROM campaign_followers f
     WHERE f.campaign_id = $1 AND f.${preference} = TRUE
       AND NOT (f.user_id = ANY($2::uuid[]))
       AND NOT EXISTS (
         SELECT 1 FROM campaign_communication_preferences p
         WHERE p.campaign_id = f.campaign_id
           AND p.user_id = f.user_id
           AND p.${CHANNEL_FOR_PREFERENCE[preference]} = FALSE
       )`,
    [campaignId, excluded]
  );

  const userIds = followers.map(f => f.user_id);
  try {
    await createNotificationsBulk(userIds, message);
  } catch (err) {
    logger.error('Bulk follower notification failed', {
      campaign_id: campaignId,
      count: userIds.length,
      error: err.message,
    });
  }
  return userIds.length;
}

function highestThresholdReached(raisedAmount, targetAmount) {
  if (!targetAmount || Number(targetAmount) <= 0) return null;
  const pct = (Number(raisedAmount) / Number(targetAmount)) * 100;
  let reached = null;
  for (const threshold of FUNDING_THRESHOLDS) {
    if (pct >= threshold) reached = threshold;
  }
  return reached;
}

/**
 * Announce a newly crossed funding threshold (25/50/75/100%) to followers.
 * Claiming the threshold row first makes this safe to call on every
 * contribution — only the call that inserts the row sends notifications.
 */
async function announceFundingProgress(campaignId) {
  const { rows } = await db.query(
    'SELECT title, raised_amount, target_amount FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!rows.length) return null;

  const campaign = rows[0];
  const threshold = highestThresholdReached(campaign.raised_amount, campaign.target_amount);
  if (!threshold) return null;

  const { rowCount } = await db.query(
    `INSERT INTO campaign_funding_milestones (campaign_id, threshold)
     VALUES ($1, $2)
     ON CONFLICT (campaign_id, threshold) DO NOTHING`,
    [campaignId, threshold]
  );
  if (!rowCount) return null;

  await notifyFollowers(campaignId, 'notify_funding', {
    type: 'campaign_funding_milestone',
    title: `${campaign.title} reached ${threshold}% funded`,
    body:
      threshold === 100
        ? 'This campaign hit its funding goal.'
        : `${Number(campaign.raised_amount).toLocaleString()} of ${Number(campaign.target_amount).toLocaleString()} raised so far.`,
    link: `/campaigns/${campaignId}`,
  });

  return threshold;
}

module.exports = {
  followCampaign,
  unfollowCampaign,
  updateFollowPreferences,
  getFollowState,
  countFollowers,
  listFollowedCampaigns,
  notifyFollowers,
  announceFundingProgress,
  highestThresholdReached,
  FUNDING_THRESHOLDS,
  CHANNEL_FOR_PREFERENCE,
};
