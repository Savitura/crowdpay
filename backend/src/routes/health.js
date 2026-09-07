const express = require('express');
const db = require('../config/database');
const Sentry = require('@sentry/node');
const logger = require('../config/logger');

const router = express.Router();

function getPoolMetrics() {
  if (typeof db.getPoolMetrics === 'function') return db.getPoolMetrics();
  return {
    total: db.totalCount || 0,
    idle: db.idleCount || 0,
    waiting: db.waitingCount || 0,
    max: db.poolMax || 0,
    utilisation: 0,
  };
}

router.get('/', async (_req, res) => {
  let metrics;
  try {
    await db.query('SELECT 1');
    metrics = getPoolMetrics();
    res.json({
      status: 'ok',
      db: { pool: metrics, utilisation: metrics.utilisation },
    });
  } catch (err) {
    logger.error('Health check database query failed', { error: err.message });
    res.status(503).json({
      error: {
        code: 'ERROR',
        message: err.message,
      },
    });
    return;
  }

  if (metrics && metrics.utilisation > 90) {
    Sentry.captureMessage(
      `Database pool utilisation exceeds 90% (current: ${metrics.utilisation}%)`,
      'warning'
    );
  }
});

module.exports = router;
