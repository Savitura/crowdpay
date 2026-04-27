const winston = require('winston');
const { getRequestContext } = require('./requestContext');

const isDev = process.env.NODE_ENV !== 'production';
const REDACTED = '[REDACTED]';
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const SENSITIVE_KEY_PATTERN = /(secret|private.?key|seed|token|authorization|cookie|password)/i;

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return STELLAR_SECRET_PATTERN.test(value) ? REDACTED : value;
  }

  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
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

const addRequestId = winston.format((info) => {
  const { requestId } = getRequestContext();
  if (requestId) info.request_id = requestId;
  return sanitizeInfoObject(info);
});

const redactSensitiveValues = winston.format((info) => {
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

module.exports = logger;
