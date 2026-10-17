const db = require('../config/database');
const logger = require('../config/logger');
const { logAuditEvent } = require('./auditService');

// Contributor communication preferences per campaign (#961).
//
// The account-level `notification_preferences` row is all-or-nothing per
// category. This service owns the per-campaign override that lets a
// contributor stay quiet about, say, milestone chatter on one noisy campaign
// while still hearing about every other campaign they support.
//
// An absent row means "no override" — the effective answer is the DEFAULT
// below, which is what every contributor gets today. That keeps the feature
// backward compatible: shipping it changes nobody's existing mail.

const CHANNELS = ['updates', 'milestones', 'funding_updates', 'messages', 'surveys'];

const CHANNEL_DESCRIPTIONS = {
  updates: 'Campaign updates and progress notes',
  milestones: 'Milestone progress, submissions, and releases',
  funding_updates: 'Funding progress milestones (25%, 50%, 75%, 100%)',
  messages: 'Replies to your comments and thank-you messages',
  surveys: 'Outcome surveys and other research from this campaign',
};

const DEFAULTS = Object.freeze(
  CHANNELS.reduce((acc, channel) => {
    acc[channel] = true;
    return acc;
  }, {})
);

/** Shape returned whenever a contributor has no stored override. */
function defaults(campaignId) {
  return { campaign_id: campaignId || null, ...DEFAULTS };
}

/**
 * Extracts the boolean channels a caller actually sent. Unknown keys and
 * non-boolean values are ignored so a client cannot smuggle extra columns in.
 *
 * @param {object} input
 * @returns {string[]} channel names present in `input`
 */
function pickChannels(input = {}) {
  return CHANNELS.filter(channel => typeof input?.[channel] === 'boolean');
}

/**
 * Effective preferences for one contributor on one campaign.
 * Returns the defaults when the contributor has never overridden anything.
 *
 * @param {string} campaignId
 * @param {string} userId
 * @returns {Promise<object>} `{ campaign_id, updates, milestones, ... }`
 */
async function getPreferences(campaignId, userId) {
  const { rows } = await db.query(
    `SELECT campaign_id, updates, milestones, funding_updates, messages, surveys
     FROM campaign_communication_preferences
     WHERE campaign_id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (!rows.length) return defaults(campaignId);
  return rows[0];
}

/**
 * Creates or partially updates a contributor's per-campaign override.
 * Only the channels present in `channels` are written, so toggling one
 * channel never clobbers the others.
 *
 * @param {string} campaignId
 * @param {string} userId
 * @param {string[]} channels channels to set
 * @param {object} values booleans keyed by channel
 * @returns {Promise<object>} the stored override row
 */
async function upsertPreferences(campaignId, userId, channels, values) {
  const columns = ['campaign_id', 'user_id', ...channels];
  const params = [campaignId, userId, ...channels.map(channel => values[channel])];
  const placeholders = params.map((_value, index) => `$${index + 1}`);

  // A partial upsert rewrites only the channels the caller sent, leaving the
  // rest of the row untouched.
  const conflictAction = `DO UPDATE SET ${channels
    .map(channel => `${channel} = EXCLUDED.${channel}`)
    .join(', ')}, updated_at = NOW()`;

  const { rows } = await db.query(
    `INSERT INTO campaign_communication_preferences (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (campaign_id, user_id) ${conflictAction}
     RETURNING campaign_id, updates, milestones, funding_updates, messages, surveys, created_at, updated_at`,
    params
  );
  return rows[0];
}

/**
 * Convenience wrapper: validates the patch, then persists it.
 *
 * @param {string} campaignId
 * @param {string} userId
 * @param {object} patch body of the PUT/PATCH request
 * @returns {Promise<{ok: true, preferences: object} | {ok: false, status: number, error: string}>}
 */
async function setPreferences(campaignId, userId, patch = {}) {
  const channels = pickChannels(patch);
  if (!channels.length) {
    return {
      ok: false,
      status: 422,
      error: `Provide at least one boolean preference: ${CHANNELS.join(', ')}`,
    };
  }
  const values = Object.fromEntries(channels.map(channel => [channel, patch[channel] === true]));
  const preferences = await upsertPreferences(campaignId, userId, channels, values);
  return { ok: true, preferences };
}

/**
 * Drops the override so the contributor falls back to the defaults.
 *
 * @returns {Promise<object>} the default preference set
 */
async function resetPreferences(campaignId, userId) {
  await db.query(
    'DELETE FROM campaign_communication_preferences WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, userId]
  );
  return defaults(campaignId);
}

/**
 * Every campaign a contributor has muted something for, newest change first.
 * Campaigns whose row was deleted (reset) or that were soft-deleted are
 * absent, which is what the notification settings screen renders.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function listForUser(userId) {
  const { rows } = await db.query(
    `SELECT p.campaign_id, c.title, c.status AS campaign_status, c.asset_type,
            p.updates, p.milestones, p.funding_updates, p.messages, p.surveys,
            p.created_at, p.updated_at
     FROM campaign_communication_preferences p
     JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.user_id = $1 AND c.deleted_at IS NULL
     ORDER BY p.updated_at DESC
     LIMIT 200`,
    [userId]
  );
  return rows;
}

/**
 * Removes every per-campaign override for a contributor.
 *
 * @returns {Promise<number>} number of rows removed
 */
async function resetAllForUser(userId) {
  const { rowCount } = await db.query(
    'DELETE FROM campaign_communication_preferences WHERE user_id = $1',
    [userId]
  );
  return rowCount;
}

/**
 * Whether a contributor still wants `channel` for `campaignId`.
 * Used by dispatch code to skip a user without loading every row.
 *
 * @param {string} campaignId
 * @param {string} userId
 * @param {string} channel
 * @returns {Promise<boolean>}
 */
async function isChannelEnabled(campaignId, userId, channel) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown communication channel: ${channel}`);
  }
  const { rows } = await db.query(
    `SELECT ${channel} AS enabled
     FROM campaign_communication_preferences
     WHERE campaign_id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (!rows.length) return DEFAULTS[channel];
  return rows[0].enabled !== false;
}

/**
 * Filters a recipient list down to those who still accept `channel` for the
 * campaign. Recipients without an override row are kept (the default is on).
 *
 * @param {string} campaignId
 * @param {string} channel
 * @param {string[]} userIds
 * @returns {Promise<string[]>} the subset that should be contacted
 */
async function filterEnabledUsers(campaignId, channel, userIds) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown communication channel: ${channel}`);
  }
  const unique = [...new Set((userIds || []).filter(Boolean))];
  if (!unique.length) return [];
  const { rows } = await db.query(
    `SELECT user_id
     FROM campaign_communication_preferences
     WHERE campaign_id = $1 AND user_id = ANY($2::uuid[]) AND ${channel} = FALSE`,
    [campaignId, unique]
  );
  const muted = new Set(rows.map(row => row.user_id));
  return unique.filter(id => !muted.has(id));
}

/**
 * Records a preference change in the audit log. Never throws: an audit write
 * must not fail a user-visible preference toggle.
 *
 * @param {object} params
 * @returns {Promise<void>}
 */
async function auditPreferenceChange({ userId, campaignId, channels, values, action, req }) {
  try {
    await logAuditEvent({
      actorId: userId,
      action,
      resourceType: 'campaign_communication_preference',
      resourceId: campaignId,
      metadata: { channels, values },
      req,
    });
  } catch (err) {
    logger.error('campaign-communication-preferences: audit log failed', {
      campaignId,
      action,
      error: err.message,
    });
  }
}

module.exports = {
  CHANNELS,
  CHANNEL_DESCRIPTIONS,
  DEFAULTS,
  defaults,
  pickChannels,
  getPreferences,
  upsertPreferences,
  setPreferences,
  resetPreferences,
  listForUser,
  resetAllForUser,
  isChannelEnabled,
  filterEnabledUsers,
  auditPreferenceChange,
};
