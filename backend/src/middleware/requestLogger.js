const logger = require('../config/logger');
const { getRequestContext } = require('../config/requestContext');

const SLOW_QUERY_THRESHOLD_MS = Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 500;
const QUERY_BUDGET_MS = Number(process.env.QUERY_BUDGET_MS) || 2000;

const SENSITIVE_PARAMS = new Set([
  'embedToken',
  'sig',
  'token',
  'secret',
  'key',
  'password',
  'api_key',
  'access_token',
  'refresh_token',
  'authorization',
  'x-api-key',
  'x-csrf-token',
  'hmac',
  'signature',
]);

function isSensitiveParam(key) {
  const lowerKey = key.toLowerCase();
  return (
    SENSITIVE_PARAMS.has(lowerKey) ||
    lowerKey.includes('secret') ||
    lowerKey.includes('key') ||
    lowerKey.includes('token') ||
    lowerKey.includes('password') ||
    lowerKey.includes('sig')
  );
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url, `http://${url.startsWith('http') ? '' : 'localhost'}`);
    // Remove query parameters
    parsed.search = '';
    return parsed.pathname;
  } catch {
    // If parsing fails, return the path part before '?'
    const questionIndex = url.indexOf('?');
    return questionIndex >= 0 ? url.substring(0, questionIndex) : url;
  }
}

function sanitizeQueryParams(query) {
  if (!query) return {};
  const params = new URLSearchParams(query);
  const sanitized = {};
  for (const [key, value] of params.entries()) {
    sanitized[key] = isSensitiveParam(key) ? '[REDACTED]' : value;
  }
  return sanitized;
}

/**
 * Builds a per-request query budget tracker. Callers (e.g. discovery query
 * code) can call `req.queryBudget.spend(ms)` to record time spent in data
 * access. When cumulative spend exceeds QUERY_BUDGET_MS a warning is logged
 * once per request. Budgets are advisory: they log, they do not abort.
 */
function createQueryBudget(requestId, path) {
  let spentMs = 0;
  let exceeded = false;
  return {
    spend(ms) {
      spentMs += ms;
      if (!exceeded && spentMs > QUERY_BUDGET_MS) {
        exceeded = true;
        logger.warn('query_budget_exceeded', {
          requestId,
          path,
          budget_ms: QUERY_BUDGET_MS,
          spent_ms: Math.round(spentMs * 100) / 100,
        });
      }
    },
    get spentMs() {
      return Math.round(spentMs * 100) / 100;
    },
    get exceeded() {
      return exceeded;
    },
  };
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const { requestId } = getRequestContext();
  const rawPath = req.originalUrl || req.url;
  const path = sanitizeUrl(rawPath);

  req.queryBudget = createQueryBudget(requestId, path);

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const duration_ms = Math.round(elapsedMs * 100) / 100;

    const method = req.method;
    const status = res.statusCode;
    const queryParams = sanitizeQueryParams(
      new URL(rawPath, `http://localhost`).search
    );

    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      method,
      path,
      status,
      duration_ms,
      requestId,
      query_ms: req.queryBudget.spentMs,
      query_budget_exceeded: req.queryBudget.exceeded,
    });

    if (duration_ms >= SLOW_QUERY_THRESHOLD_MS) {
      logger.warn('slow_request', {
        method,
        path,
        status,
        duration_ms,
        query_ms: req.queryBudget.spentMs,
        threshold_ms: SLOW_QUERY_THRESHOLD_MS,
        requestId,
        // Only sanitized params are ever logged; sensitive values are redacted.
        params: Object.keys(queryParams).length ? queryParams : undefined,
      });
    }
  });

  next();
}

module.exports = { requestLogger, createQueryBudget, sanitizeUrl, sanitizeQueryParams };
