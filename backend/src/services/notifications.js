const db = require('../config/database');
const logger = require('../config/logger');
const withTransaction = require('../utils/withTransaction');
const channels = require('./notificationChannels');
const fcmPush = require('./fcmPushService');

// Multi-channel notification orchestration (issue #429).
//
// `createNotification` remains the single entry point used across the codebase.
// It always writes the in-app notification (preserving existing behaviour) and
// additionally fans the message out to any external channels the user has
// configured and enabled. Non-critical notifications that arrive during a
// user's quiet hours are parked in `notification_queue` and flushed later as a
// digest by `flushQuietHours`.
//
// `notification_queue` is list-partitioned by channel (see the
// 20261015 migration). Each channel is flushed in its own pass so a backlog on
// one channel never delays or locks rows belonging to another.

// Channels that can carry queued digests. Mirrors the partition list in the
// migration; 'in_app' is never queued.
const QUEUEABLE_CHANNELS = ['email', 'push', 'slack', 'discord', 'sms'];

// Persist the in-app notification row. This is the baseline channel and is
// always delivered.
async function insertInApp(userId, { type, title, body, link }) {
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, body || null, link || null]
  );
}

async function loadChannelSettings(userId) {
  const { rows } = await db.query(
    `SELECT push_token, slack_webhook_url, discord_webhook_url, sms_phone_number,
            quiet_hours_start, quiet_hours_end,
            EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $1) AS push_enabled
     FROM notification_channel_settings
     WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// Per-event-type channel overrides. Returns a map channel -> enabled.
async function loadPreferences(userId, eventType) {
  const { rows } = await db.query(
    `SELECT channel, enabled
     FROM notification_preferences
     WHERE user_id = $1 AND event_type = $2`,
    [userId, eventType]
  );
  const map = {};
  for (const r of rows) map[r.channel] = r.enabled;
  return map;
}

// Whether an external channel should receive this event. A channel is on when
// it has a destination configured and the user has not explicitly disabled it
// for this event type.
function channelEnabled(channel, prefs, settings) {
  if (channel === 'push') {
    if (!settings?.push_enabled) return false;
    const override = prefs.push;
    return override === undefined ? true : override === true;
  }
  if (!channels.destinationFor(channel, settings)) return false;
  const override = prefs[channel];
  return override === undefined ? true : override === true;
}

async function deliverChannel(userId, channel, settings, message) {
  if (channel === 'push' && settings.push_enabled) {
    try {
      return await fcmPush.sendToUser(userId, message);
    } catch (err) {
      logger.error('FCM notification delivery failed', {
        user_id: userId,
        type: message.type,
        error: err.message,
      });
      return false;
    }
  }
  return channels.deliver(channel, settings, message);
}

// Determine whether `nowHour` (0-23) falls inside the user's quiet-hours
// window. Supports windows that wrap past midnight (start=22, end=7).
function inQuietHours(settings, nowHour) {
  if (!settings) return false;
  const start = settings.quiet_hours_start;
  const end = settings.quiet_hours_end;
  if (start === null || start === undefined || end === null || end === undefined) return false;
  if (start === end) return false;
  if (start < end) return nowHour >= start && nowHour < end;
  // Wrapping window: e.g. 22:00 -> 07:00.
  return nowHour >= start || nowHour < end;
}

// Queue rows are written with the channel as the partition key, so Postgres
// routes them straight into the matching partition.
async function queueForDigest(userId, channel, message) {
  if (!QUEUEABLE_CHANNELS.includes(channel)) {
    throw new Error(`channel ${channel} is not queueable`);
  }
  await db.query(
    `INSERT INTO notification_queue (user_id, channel, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, channel, message.type, message.title, message.body || null, message.link || null]
  );
}

// Release rows back to the pending set. Filtering on channel lets Postgres
// prune to the relevant partitions instead of probing every one.
async function releaseQueuedRows(channel, rowIds) {
  if (!rowIds.length) return;
  await db.query(
    'UPDATE notification_queue SET flushed_at = NULL WHERE channel = $1 AND id = ANY($2::uuid[])',
    [channel, rowIds]
  );
}

/**
 * Create a notification for a user and fan it out across every enabled channel.
 *
 * Always writes the in-app notification. External channels (push, Slack,
 * Discord, SMS) are delivered when the user has configured a destination and
 * not disabled the channel for this event type. Non-critical events that land
 * during quiet hours are queued for a later digest instead of delivered
 * immediately; critical events (deadlines, withdrawal decisions) always go out
 * right away.
 *
 * @param {number} [nowHour] Current local hour (0-23); injectable for testing.
 */
async function createNotification(userId, { type, title, body, link }, { nowHour } = {}) {
  const message = { type, title, body, link };
  try {
    await insertInApp(userId, message);
  } catch (err) {
    logger.error('Failed to create notification', { user_id: userId, type, error: err.message });
  }

  try {
    const settings = await loadChannelSettings(userId);
    if (!settings) return;

    const prefs = await loadPreferences(userId, type);
    const hour = nowHour !== undefined ? nowHour : new Date().getHours();
    const quiet = inQuietHours(settings, hour) && !channels.isCriticalEvent(type);

    for (const channel of channels.CHANNELS) {
      if (channel === 'in_app') continue;
      if (!channelEnabled(channel, prefs, settings)) continue;

      if (quiet) {
        await queueForDigest(userId, channel, message);
      } else {
        await deliverChannel(userId, channel, settings, message);
      }
    }
  } catch (err) {
    logger.error('Notification channel fan-out failed', {
      user_id: userId,
      type,
      error: err.message,
    });
  }
}

/**
 * Fan a notification out to a batch of user IDs efficiently.
 */
async function createNotificationsBulk(userIds, message, options = {}) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  await Promise.all(userIds.map(userId => createNotification(userId, message, options)));
}

// Claim and drain the pending queue for a single channel. Each channel runs in
// its own transaction so claims never cross partitions and one channel's
// failure cannot roll back another's work.
async function flushChannel(channel, nowHour) {
  let rows = [];
  await withTransaction(async client => {
    const res = await client.query(
      `SELECT q.id, q.user_id, q.channel, q.type, q.title, q.body, q.link,
            s.push_token, s.slack_webhook_url, s.discord_webhook_url, s.sms_phone_number,
            s.quiet_hours_start, s.quiet_hours_end,
            EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = q.user_id) AS push_enabled
     FROM notification_queue q
     JOIN notification_channel_settings s ON s.user_id = q.user_id
     WHERE q.channel = $1 AND q.flushed_at IS NULL
     ORDER BY q.created_at ASC
       LIMIT 200
       FOR UPDATE OF q SKIP LOCKED`,
      [channel]
    );
    rows = res.rows;
    if (rows.length > 0) {
      const rowIds = rows.map(r => r.id);
      await client.query(
        'UPDATE notification_queue SET flushed_at = NOW() WHERE channel = $1 AND id = ANY($2::uuid[])',
        [channel, rowIds]
      );
    }
  }, db);

  // Group deliverable rows by user so each user gets one digest per channel.
  const groups = new Map();
  const quietHourIds = [];

  for (const row of rows) {
    if (inQuietHours(row, nowHour)) {
      quietHourIds.push(row.id);
      continue;
    }

    if (!groups.has(row.user_id)) {
      groups.set(row.user_id, {
        userId: row.user_id,
        settings: {
          push_token: row.push_token,
          push_enabled: row.push_enabled,
          slack_webhook_url: row.slack_webhook_url,
          discord_webhook_url: row.discord_webhook_url,
          sms_phone_number: row.sms_phone_number,
        },
        items: [],
      });
    }
    groups.get(row.user_id).items.push({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      link: row.link,
    });
  }

  await releaseQueuedRows(channel, quietHourIds);

  let deliveredCount = 0;

  for (const group of groups.values()) {
    // Build a digest message combining all queued items for this user/channel.
    const lastItem = group.items[group.items.length - 1];
    const digestMessage = {
      type: lastItem.type,
      title: `${group.items.length} notifications: ${group.items.map(i => i.title).join('; ')}`,
      body: group.items
        .map(i => i.body)
        .filter(Boolean)
        .join('\n'),
      link: lastItem.link,
      items: group.items,
    };

    try {
      const delivered = await deliverChannel(group.userId, channel, group.settings, digestMessage);
      if (!delivered) {
        await releaseQueuedRows(channel, group.items.map(item => item.id));
        continue;
      }
      deliveredCount++;
    } catch (err) {
      logger.error('Failed to flush digest notification', {
        user_id: group.userId,
        channel,
        error: err.message,
      });
      await releaseQueuedRows(channel, group.items.map(item => item.id));
    }
  }

  return deliveredCount;
}

/**
 * Drain queued digests, one channel partition at a time.
 *
 * @returns {Promise<number>} Count of digests delivered across all channels.
 */
async function flushQuietHours(options = {}) {
  const nowHour = options.nowHour !== undefined ? options.nowHour : new Date().getHours();
  let total = 0;
  for (const channel of QUEUEABLE_CHANNELS) {
    total += await flushChannel(channel, nowHour);
  }
  return total;
}

module.exports = {
  createNotification,
  createNotificationsBulk,
  flushQuietHours,
  flushChannel,
  loadChannelSettings,
  loadPreferences,
  channelEnabled,
  inQuietHours,
  QUEUEABLE_CHANNELS,
};
