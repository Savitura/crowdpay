const express = require('express');
const db = require('../config/database');
const redis = require('../config/redis');
const Sentry = require('@sentry/node');
const logger = require('../config/logger');
const { isEmailConfigured, verifyEmailTransport } = require('../services/emailService');
const { getMissingConfig } = require('../config/env');

const router = express.Router();

const DEFAULT_CHECK_TIMEOUT_MS = Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || 2000;

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

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function safeFailure(err) {
  if (err?.code === 'ETIMEDOUT' || err?.name === 'AbortError') {
    return 'timeout';
  }
  return 'unavailable';
}

async function checkDatabase(timeoutMs) {
  const started = Date.now();
  try {
    await withTimeout(db.query('SELECT 1'), timeoutMs, 'database');
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness database check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  }
}

async function checkRedis(timeoutMs) {
  const started = Date.now();
  try {
    await withTimeout(redis.ping(), timeoutMs, 'redis');
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Redis check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  }
}

async function checkHorizon(timeoutMs) {
  const started = Date.now();
  const horizonUrl = process.env.STELLAR_HORIZON_URL;
  if (!horizonUrl) {
    return { status: 'error', error: 'not_configured', latency_ms: Date.now() - started };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await withTimeout(
      fetch(`${horizonUrl.replace(/\/+$/, '')}/fee_stats`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }),
      timeoutMs,
      'horizon'
    );
    if (!response.ok) {
      return {
        status: 'error',
        error: 'http_error',
        http_status: response.status,
        latency_ms: Date.now() - started,
      };
    }
    return { status: 'ok', http_status: response.status, latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Horizon check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSoroban(timeoutMs) {
  const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_SOROBAN_RPC_URL;
  if (!rpcUrl) return null;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await withTimeout(
      fetch(rpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      }),
      timeoutMs,
      'soroban'
    );
    if (!response.ok) {
      return {
        status: 'error',
        error: 'http_error',
        http_status: response.status,
        latency_ms: Date.now() - started,
      };
    }
    const body = await withTimeout(response.json(), timeoutMs, 'soroban');
    if (body?.error) {
      return {
        status: 'error',
        error: 'rpc_error',
        latency_ms: Date.now() - started,
      };
    }
    return { status: 'ok', http_status: response.status, latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Soroban RPC check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkRpc(timeoutMs) {
  const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_SOROBAN_RPC_URL;
  if (!rpcUrl) {
    return { status: 'error', error: 'not_configured', latency_ms: 0 };
  }
  return checkSoroban(timeoutMs);
}

async function checkEmail(timeoutMs) {
  const started = Date.now();
  const emailsDisabled = String(process.env.DISABLE_EMAILS || '').toLowerCase() === 'true';
  if (emailsDisabled) {
    return { status: 'ok', disabled: true, latency_ms: Date.now() - started };
  }

  if (typeof isEmailConfigured === 'function' && !isEmailConfigured()) {
    return {
      status: 'error',
      error: 'not_configured',
      latency_ms: Date.now() - started,
    };
  }

  try {
    if (typeof verifyEmailTransport === 'function') {
      await withTimeout(verifyEmailTransport(), timeoutMs, 'email');
    }
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Email check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  }
}

function checkConfig() {
  const missing = getMissingConfig();
  if (missing.length) {
    return { status: 'error', error: 'missing_configuration', missing };
  }
  return { status: 'ok' };
}

const CANONICAL_SERVICES = {
  database: 'database',
  db: 'database',
  postgres: 'database',
  horizon: 'horizon',
  rpc: 'rpc',
  soroban: 'rpc',
  email: 'email',
  mail: 'email',
  smtp: 'email',
  redis: 'redis',
  cache: 'redis',
  config: 'config',
};

const SEPARATE_CHECK_HANDLERS = {
  database: checkDatabase,
  horizon: checkHorizon,
  rpc: checkRpc,
  email: checkEmail,
  redis: checkRedis,
  config: async () => checkConfig(),
};

const VALID_CHECKS = ['database', 'horizon', 'rpc', 'email', 'redis', 'config'];

// Liveness: deliberately dependency-free so a degraded dependency can never
// cause an orchestrator to restart an otherwise healthy process.
router.get('/live', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Readiness: every dependency is checked independently and concurrently. A
// failure is reported by name with a safe error class, never a raw message.
// Supports query parameter filtering (e.g. ?check=database,rpc or ?checks=email).
router.get('/ready', async (req, res) => {
  const timeoutMs =
    Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || DEFAULT_CHECK_TIMEOUT_MS;

  const requestedFilter = req.query.check || req.query.checks || req.query.service;
  if (requestedFilter) {
    const requestedNames = String(requestedFilter)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const checkPromises = [];
    const checkNames = [];

    for (const raw of requestedNames) {
      const canonical = CANONICAL_SERVICES[raw];
      if (canonical && SEPARATE_CHECK_HANDLERS[canonical] && !checkNames.includes(canonical)) {
        checkNames.push(canonical);
        checkPromises.push(SEPARATE_CHECK_HANDLERS[canonical](timeoutMs));
      }
    }

    if (checkNames.length === 0) {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({
        status: 'error',
        error: 'invalid_filter',
        message: 'No valid checks specified in filter',
        valid_checks: VALID_CHECKS,
      });
    }

    const results = await Promise.all(checkPromises);
    const checks = {};
    checkNames.forEach((name, idx) => {
      checks[name] = results[idx];
    });

    const failed = Object.entries(checks)
      .filter(([, result]) => result.status !== 'ok')
      .map(([name]) => name);

    res.set('Cache-Control', 'no-store');
    return res.status(failed.length ? 503 : 200).json({
      status: failed.length ? 'degraded' : 'ok',
      failed,
      checks,
    });
  }

  // Default aggregate readiness check:
  // Checks database, redis, horizon, config, and soroban (if configured).
  // Also checks email if explicitly requested via include_email=true or CHECK_EMAIL_READINESS=true.
  const checkEmailEnabled =
    req.query.include_email === 'true' || process.env.CHECK_EMAIL_READINESS === 'true';

  const [database, cache, horizon, soroban, emailResult] = await Promise.all([
    checkDatabase(timeoutMs),
    checkRedis(timeoutMs),
    checkHorizon(timeoutMs),
    checkSoroban(timeoutMs),
    checkEmailEnabled ? checkEmail(timeoutMs) : Promise.resolve(null),
  ]);
  const checks = {
    database,
    redis: cache,
    horizon,
    config: checkConfig(),
  };
  if (soroban) checks.soroban = soroban;
  if (emailResult) checks.email = emailResult;
  const failed = Object.entries(checks)
    .filter(([, result]) => result.status !== 'ok')
    .map(([name]) => name);

  res.set('Cache-Control', 'no-store');
  res.status(failed.length ? 503 : 200).json({
    status: failed.length ? 'degraded' : 'ok',
    failed,
    checks,
  });
});

// Separate readiness check endpoint for individual subsystem probes (e.g. database, horizon, rpc, email).
router.get('/ready/:service', async (req, res) => {
  const rawService = String(req.params.service || '').toLowerCase();
  const canonicalName = CANONICAL_SERVICES[rawService];

  if (!canonicalName || !SEPARATE_CHECK_HANDLERS[canonicalName]) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({
      status: 'error',
      error: 'unknown_check',
      message: `Unknown readiness check: ${req.params.service}`,
      valid_checks: VALID_CHECKS,
    });
  }

  const timeoutMs =
    Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || DEFAULT_CHECK_TIMEOUT_MS;
  const handler = SEPARATE_CHECK_HANDLERS[canonicalName];
  const result = await handler(timeoutMs);

  const isOk = result.status === 'ok';
  res.set('Cache-Control', 'no-store');
  res.status(isOk ? 200 : 503).json({
    status: isOk ? 'ok' : 'degraded',
    service: canonicalName,
    [canonicalName]: result,
  });
});

// Backwards-compatible aggregate health endpoint. Prefer /health/ready for
// orchestrator readiness probes and /health/live for liveness probes.
router.get('/', async (_req, res) => {
  let metrics;
  try {
    await db.query('SELECT 1');
    metrics = getPoolMetrics();
    const { utilisation, ...pool } = metrics;
    res.json({
      status: 'ok',
      db: { pool, utilisation },
      email: isEmailConfigured() ? 'ready' : 'unconfigured',
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
module.exports.checkConfig = checkConfig;
module.exports.checkDatabase = checkDatabase;
module.exports.checkHorizon = checkHorizon;
module.exports.checkRedis = checkRedis;
module.exports.checkSoroban = checkSoroban;
module.exports.checkRpc = checkRpc;
module.exports.checkEmail = checkEmail;
module.exports.withTimeout = withTimeout;
module.exports.CANONICAL_SERVICES = CANONICAL_SERVICES;
module.exports.VALID_CHECKS = VALID_CHECKS;
