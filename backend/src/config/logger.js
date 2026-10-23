const winston = require('winston');
const { getRequestContext } = require('./requestContext');

const isDev = process.env.NODE_ENV !== 'production';
const REDACTED = '[REDACTED]';
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const SENSITIVE_KEY_PATTERN = /(secret|private.?key|seed|token|authorization|cookie|password)/i;

// Query budget and slow-query logging configuration.
// QUERY_BUDGET_MS: queries exceeding this duration are logged as slow (default 500ms).
// QUERY_BUDGET_ROWS: result sets exceeding this row count are flagged (default 1000).
const QUERY_BUDGET_MS = Number(process.env.QUERY_BUDGET_MS) || 500;
const QUERY_BUDGET_ROWS = Number(process.env.QUERY_BUDGET_ROWS) || 1000;

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return STELLAR_SECRET_PATTERN.test(value) ? REDACTED : value;
  }

  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(entry => sanitizeValue(entry, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeValue(entry, seen),
    ])
  );
}

function sanitizeInfoObject(info) {
  const sanitized = sanitizeValue(info);
  for (const key of Object.keys(info)) {
    delete info[key];
  }
  Object.assign(info, sanitized);
  return info;
}

const addRequestId = winston.format(info => {
  const { requestId } = getRequestContext();
  if (requestId) info.request_id = requestId;
  return sanitizeInfoObject(info);
});

const redactSensitiveValues = winston.format(info => {
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    addRequestId(),
    redactSensitiveValues(),
    winston.format.timestamp(),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, request_id, ...meta }) => {
            const idStr = request_id ? ` [${String(request_id).slice(0, 8)}]` : '';
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp}${idStr} ${level}: ${message}${metaStr}`;
          })
        )
      : winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

/**
 * Logs a campaign discovery query that exceeds its time or row budget.
 * Query text and parameters are passed through the sanitizer so that any
 * secret-like values are redacted before being emitted.
 *
 * @param {object} details
 * @param {string} details.operation - Name of the discovery operation.
 * @param {number} details.durationMs - Measured query duration in milliseconds.
 * @param {number} [details.rowCount] - Number of rows returned.
 * @param {object} [details.params] - Query parameters (sanitized before logging).
 * @returns {boolean} true if a slow-query warning was emitted.
 */
function logSlowQuery({ operation, durationMs, rowCount, params } = {}) {
  const overTime = typeof durationMs === 'number' && durationMs > QUERY_BUDGET_MS;
  const overRows = typeof rowCount === 'number' && rowCount > QUERY_BUDGET_ROWS;
  if (!overTime && !overRows) return false;

  logger.warn('slow query detected', {
    event: 'slow_query',
    operation,
    duration_ms: durationMs,
    row_count: rowCount,
    budget_ms: QUERY_BUDGET_MS,
    budget_rows: QUERY_BUDGET_ROWS,
    exceeded: { time: overTime, rows: overRows },
    params: sanitizeValue(params),
  });
  return true;
}

/**
 * Wraps an async query function, measuring its duration and enforcing
 * logging against the configured budgets. The result is returned unchanged,
 * so existing API/UI behavior is preserved.
 *
 * @template T
 * @param {string} operation
 * @param {object} params
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withQueryBudget(operation, params, fn) {
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const rowCount = Array.isArray(result)
      ? result.length
      : Array.isArray(result && result.rows)
        ? result.rows.length
        : undefined;
    logSlowQuery({ operation, durationMs, rowCount, params });
    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.error('query failed', {
      event: 'query_error',
      operation,
      duration_ms: durationMs,
      error: err && err.message,
      params: sanitizeValue(params),
    });
    throw err;
  }
}

logger.logSlowQuery = logSlowQuery;
logger.withQueryBudget = withQueryBudget;
logger.QUERY_BUDGET_MS = QUERY_BUDGET_MS;
logger.QUERY_BUDGET_ROWS = QUERY_BUDGET_ROWS;

module.exports = logger;
