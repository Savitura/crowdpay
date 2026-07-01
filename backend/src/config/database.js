const { Pool } = require('pg');
const logger = require('./logger');

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
  throw new Error(
    'DATABASE_URL environment variable is required. Set it in your .env file.'
  );
}

const POOL_MAX = parseInt(process.env.DB_POOL_MAX || '10', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
});

const WAITING_THRESHOLD = parseInt(process.env.DB_POOL_WAITING_THRESHOLD || '5', 10);

pool.on('error', (err) => {
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
