const redis = require('../config/redis');
const logger = require('../config/logger');

const IP_LIMIT = 10;
const WALLET_LIMIT = 5;
const WINDOW_SECONDS = 60;

/**
 * Returns a list of wallet public keys that bypass rate limiting.
 * Configured via the RATE_LIMIT_BYPASS_ACCOUNTS environment variable
 * (comma-separated list).
 *
 * ⚠️ SECURITY WARNING: Adding accounts to this list allows them to make
 * unlimited contribution requests. Only use for automated test accounts
 * in non-production environments. Never add real user accounts in production.
 */
function getTestAccountBypasses() {
  const raw = process.env.RATE_LIMIT_BYPASS_ACCOUNTS || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Rate limiter for contribution endpoints.
 *
 * Limits:
 * - 10 requests per minute per IP
 * - 5 requests per minute per wallet public key
 *
 * Fail-open behavior:
 * If Redis is unavailable or any other error occurs, the middleware calls
 * next() without blocking the request. This ensures contributions are never
 * blocked by infrastructure issues. A warning is logged with the error details
 * so operators can observe and alert on Redis outages.
 *
 * Bypass:
 * Wallet public keys listed in RATE_LIMIT_BYPASS_ACCOUNTS are exempt from
 * rate limiting entirely. This is intended for automated test accounts only.
 */
async function contributionRateLimiter(req, res, next) {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const walletPublicKey = req.body?.wallet_public_key || req.user?.walletPublicKey || null;

    const bypassAccounts = getTestAccountBypasses();
    if (walletPublicKey && bypassAccounts.includes(walletPublicKey)) {
      return next();
    }

    const now = Date.now();
    const windowKeySuffix = Math.floor(now / (WINDOW_SECONDS * 1000));
    const ipKey = `rl:contrib:ip:${ip}:${windowKeySuffix}`;
    const walletKey = walletPublicKey
      ? `rl:contrib:wallet:${walletPublicKey}:${windowKeySuffix}`
      : null;

    const pipeline = redis.pipeline();
    pipeline.incr(ipKey);
    pipeline.expire(ipKey, WINDOW_SECONDS * 2);

    if (walletKey) {
      pipeline.incr(walletKey);
      pipeline.expire(walletKey, WINDOW_SECONDS * 2);
    }

    const results = await pipeline.exec();

    let ipCount = 0;
    if (results && results[0] && !results[0][0]) {
      ipCount = results[0][1];
    }

    let walletCount = 0;
    if (walletKey && results && results[2] && !results[2][0]) {
      walletCount = results[2][1];
    }

    if (ipCount > IP_LIMIT || walletCount > WALLET_LIMIT) {
      logger.warn('Rate limit exceeded on contribution endpoint', {
        ip,
        walletPublicKey,
        ipCount,
        walletCount,
        timestamp: new Date().toISOString(),
      });

      res.setHeader('Retry-After', String(WINDOW_SECONDS));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retry_after: WINDOW_SECONDS,
      });
    }

    next();
  } catch (err) {
    logger.error('Error in contributionRateLimiter middleware', { error: err.message });
    // Fail open if Redis is down to prevent taking down contributions
    // A warning is logged so operators can observe and alert on Redis outages
    next();
  }
}

module.exports = {
  contributionRateLimiter,
  IP_LIMIT,
  WALLET_LIMIT,
};
