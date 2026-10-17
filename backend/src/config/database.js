const { Pool } = require('pg');
const logger = require('./logger');

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
  throw new Error('DATABASE_URL environment variable is required. Set it in your .env file.');
}

/**
 * Parses and validates a positive integer environment variable.
 * @param {string} name - Environment variable name
 * @param {string} value - Raw value from process.env
 * @param {number} defaultValue - Default value if unset
 * @returns {number} Validated integer
 * @throws {Error} If value is set but invalid
 */
function parsePositiveInt(name, value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  // Reject non-integer strings (e.g., "10.5", "abc", "0", "-1")
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer (received: ${JSON.stringify(value)})`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received: ${JSON.stringify(value)})`);
  }
  return parsed;
}

/**
 * Parses and validates a non-negative integer environment variable.
 * @param {string} name - Environment variable name
 * @param {string} value - Raw value from process.env
 * @param {number} defaultValue - Default value if unset
 * @returns {number} Validated integer
 * @throws {Error} If value is set but invalid
 */
function parseNonNegativeInt(name, value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  // Reject non-integer strings (e.g., "10.5", "abc", "-1")
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer (received: ${JSON.stringify(value)})`);
  }
  return Number.parseInt(value, 10);
}

const POOL_MAX = parsePositiveInt('DB_POOL_MAX', process.env.DB_POOL_MAX, 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: parsePositiveInt('DB_IDLE_TIMEOUT_MS', process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: parsePositiveInt(
    'DB_CONNECTION_TIMEOUT_MS',
    process.env.DB_CONNECTION_TIMEOUT_MS,
    5000
  ),
});

const WAITING_THRESHOLD = parseNonNegativeInt(
  'DB_POOL_WAITING_THRESHOLD',
  process.env.DB_POOL_WAITING_THRESHOLD,
  5
);

pool.on('error', err => {
  logger.error('Unexpected database pool error', { error: err.message });
});

pool.on('connect', () => {
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug('New client connected to database pool', {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });
  }
});

function getPoolMetrics() {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  const max = POOL_MAX;
  const utilisation = max > 0 ? Math.round(((total - idle) / max) * 10000) / 100 : 0;

  if (waiting > WAITING_THRESHOLD) {
    logger.warn('Database pool under pressure — waiting connections exceed threshold', {
      total,
      idle,
      waiting,
      max,
      utilisation,
      threshold: WAITING_THRESHOLD,
    });
  }

  return { total, idle, waiting, max, utilisation };
}

module.exports = pool;
module.exports.getPoolMetrics = getPoolMetrics;
module.exports.poolMax = POOL_MAX;
