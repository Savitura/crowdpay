const redis = require('../config/redis');
const logger = require('../config/logger');
const {
  WITHDRAWAL_ATTEMPT_LIMIT,
  WITHDRAWAL_ATTEMPT_WINDOW_SECONDS,
  REFUND_ATTEMPT_LIMIT,
  REFUND_ATTEMPT_WINDOW_SECONDS,
} = require('../config/constants');

const warnedInvalidEnv = new Set();

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  if (!warnedInvalidEnv.has(name)) {
    warnedInvalidEnv.add(name);
    logger.warn('Ignoring invalid financial action rate limit setting', {
      variable: name,
      fallback,
    });
  }
  return fallback;
}

/**
 * Per-user attempt limiter for money-moving actions (withdrawals, refunds).
 *
 * Uses the same Redis fixed-window counter as contributionRateLimiter: one
 * INCR per attempt on `rl:fin:<action>:<subject>:<window index>`, keyed by the
 * authenticated user id (IP only if no user is attached). Every attempt counts,
 * including ones the handler later rejects, so payload probing is throttled too.
 *
 * Mount it after requireAuth and before validation or any handler that touches
 * the database, Stellar or wallet keys.
 *
 * Fail-open: if Redis errors, the request proceeds and an error is logged, the
 * same trade-off contributionRateLimiter makes. The handlers' own authorization,
 * idempotency and custodial signing limits still apply.
 */
function createFinancialActionLimiter({
  action,
  limitEnv,
  windowEnv,
  defaultLimit,
  defaultWindowSeconds,
  redisClient = redis,
  now = Date.now,
}) {
  return async function financialActionRateLimiter(req, res, next) {
    try {
      const limit = readPositiveIntEnv(limitEnv, defaultLimit);
      const windowSeconds = readPositiveIntEnv(windowEnv, defaultWindowSeconds);
      const windowMs = windowSeconds * 1000;

      const userId = req.user?.userId;
      const subject = userId
        ? `user:${userId}`
        : `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;

      const currentTime = now();
      const windowIndex = Math.floor(currentTime / windowMs);
      const key = `rl:fin:${action}:${subject}:${windowIndex}`;

      const pipeline = redisClient.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, windowSeconds * 2);
      const results = await pipeline.exec();

      const [incrError, count] = (results && results[0]) || [];
      if (incrError) throw incrError;

      if (Number(count) > limit) {
        const retryAfter = Math.max(
          1,
          Math.ceil(((windowIndex + 1) * windowMs - currentTime) / 1000)
        );
        logger.warn('Rate limit exceeded on financial action', {
          action,
          userId: userId || null,
          count: Number(count),
          limit,
          windowSeconds,
        });
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Too many ${action} attempts. Please try again later.`,
          retry_after: retryAfter,
        });
      }

      return next();
    } catch (err) {
      logger.error('Error in financialActionRateLimiter middleware; failing open', {
        action,
        error: err.message,
      });
      return next();
    }
  };
}

const withdrawalAttemptLimiter = createFinancialActionLimiter({
  action: 'withdrawal',
  limitEnv: 'WITHDRAWAL_ATTEMPT_LIMIT',
  windowEnv: 'WITHDRAWAL_ATTEMPT_WINDOW_SECONDS',
  defaultLimit: WITHDRAWAL_ATTEMPT_LIMIT,
  defaultWindowSeconds: WITHDRAWAL_ATTEMPT_WINDOW_SECONDS,
});

const refundAttemptLimiter = createFinancialActionLimiter({
  action: 'refund',
  limitEnv: 'REFUND_ATTEMPT_LIMIT',
  windowEnv: 'REFUND_ATTEMPT_WINDOW_SECONDS',
  defaultLimit: REFUND_ATTEMPT_LIMIT,
  defaultWindowSeconds: REFUND_ATTEMPT_WINDOW_SECONDS,
});

module.exports = {
  createFinancialActionLimiter,
  withdrawalAttemptLimiter,
  refundAttemptLimiter,
};
