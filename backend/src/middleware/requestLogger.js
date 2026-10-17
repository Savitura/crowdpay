const logger = require('../config/logger');
const { getRequestContext } = require('../config/requestContext');

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

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const duration_ms = Math.round(elapsedMs * 100) / 100;

    const method = req.method;
    const status = res.statusCode;
    const path = sanitizeUrl(req.originalUrl || req.url);
    const queryParams = sanitizeQueryParams(
      new URL(req.originalUrl || req.url, `http://localhost`).search
    );

    const { requestId } = getRequestContext();

    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('request', { method, path, status, duration_ms, requestId });
  });

  next();
}

module.exports = { requestLogger };
