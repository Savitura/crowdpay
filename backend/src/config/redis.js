const Redis = require('ioredis');
const logger = require('./logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on('error', err => {
  logger.error('Redis connection error', { error: err.message });
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

/**
 * Builds the Redis key for a notification delivery queue partitioned by channel.
 * Each channel (e.g. email, sms, push, webhook) gets its own queue so that a
 * high-volume channel cannot starve delivery on the others.
 *
 * Key format: notifications:queue:<channel>
 *
 * @param {string} channel - Delivery channel name
 * @returns {string} Redis key for that channel's queue
 */
function notificationQueueKey(channel) {
  if (typeof channel !== 'string' || channel.trim() === '') {
    throw new TypeError('channel must be a non-empty string');
  }
  const normalized = channel.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new TypeError(`invalid notification channel: ${channel}`);
  }
  return `notifications:queue:${normalized}`;
}

/**
 * Enqueues a notification payload onto the queue for its channel.
 *
 * @param {string} channel - Delivery channel name
 * @param {object} payload - Serializable notification payload
 * @returns {Promise<number>} Length of the channel queue after push
 */
async function enqueueNotification(channel, payload) {
  const key = notificationQueueKey(channel);
  return redis.rpush(key, JSON.stringify(payload));
}

/**
 * Dequeues up to `count` notifications from a single channel's queue.
 *
 * @param {string} channel - Delivery channel name
 * @param {number} [count=1] - Maximum number of items to pop
 * @returns {Promise<object[]>} Parsed payloads, oldest first
 */
async function dequeueNotifications(channel, count = 1) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('count must be a positive integer');
  }
  const key = notificationQueueKey(channel);
  const items = await redis.lpop(key, count);
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.map(item => JSON.parse(item));
}

module.exports = redis;
module.exports.notificationQueueKey = notificationQueueKey;
module.exports.enqueueNotification = enqueueNotification;
module.exports.dequeueNotifications = dequeueNotifications;
