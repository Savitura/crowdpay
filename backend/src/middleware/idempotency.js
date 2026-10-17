/**
 * Idempotency middleware for mutable HTTP endpoints.
 *
 * When a client sends an `Idempotency-Key` header, the response for that key
 * is cached in Redis for IDEMPOTENCY_TTL_SECONDS. A second request with the
 * same key and same HTTP method to the same path receives the cached response
 * without re-executing the handler.
 *
 * Design notes
 * ─────────────
 * • The lock key is `idempotency:lock:<key>` (SET NX EX 30s). A racing
 *   concurrent request that fails to acquire the lock receives 409 rather
 *   than running the handler twice.
 * • The result key is `idempotency:result:<key>`.  It stores the status code
 *   and JSON body so the cached response is byte-for-byte identical.
 * • Fail-open: if Redis is unavailable the middleware calls next() without
 *   caching so the endpoint still works; a warning is logged.
 * • Only POST (and optionally PATCH/PUT) should use this middleware. GET is
 *   idempotent by definition and should never be wrapped here.
 */

const redis = require('../config/redis');
const logger = require('../config/logger');

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours
const LOCK_TTL_SECONDS = 30;
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Build Redis key prefixes scoped to a specific route so keys from different
 * endpoints never collide even when a client reuses the same UUID.
 *
 * @param {string} scope  Short string identifying the route, e.g. 'anchor:deposit'
 * @returns {{ lockKey: (k:string)=>string, resultKey: (k:string)=>string }}
 */
function buildKeyHelpers(scope) {
  return {
    lockKey: k => `idempotency:lock:${scope}:${k}`,
    resultKey: k => `idempotency:result:${scope}:${k}`,
  };
}

/**
 * Create an Express middleware that enforces idempotency for a given route scope.
 *
 * @param {string} scope  Unique label for the route (used in Redis key prefix)
 * @returns {import('express').RequestHandler}
 */
function idempotency(scope) {
  const { lockKey, resultKey } = buildKeyHelpers(scope);

  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (!rawKey) {
      // No idempotency key supplied — just pass through.
      return next();
    }

    // Sanitise: keys must be non-empty and ≤ 255 chars to stay within Redis limits.
    const key = String(rawKey).trim().slice(0, 255);
    if (!key) return next();

    try {
      // ── Check for a previously cached result ──────────────────────────────
      const cached = await redis.get(resultKey(key));
      if (cached) {
        let parsed;
        try {
          parsed = JSON.parse(cached);
        } catch {
          // Corrupted cache entry — fall through and let the handler run again.
          logger.warn('Idempotency cache entry corrupted; re-executing handler', { scope, key });
          return next();
        }
        res.setHeader('Idempotency-Replay', 'true');
        return res.status(parsed.status).json(parsed.body);
      }

      // ── Acquire a short-lived lock ─────────────────────────────────────────
      const locked = await redis.set(lockKey(key), '1', 'EX', LOCK_TTL_SECONDS, 'NX');
      if (!locked) {
        // Another request with the same key is in flight right now.
        return res.status(409).json({
          error:
            'A request with this Idempotency-Key is already being processed. Retry after a moment.',
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }

      // ── Intercept the response to cache it ────────────────────────────────
      const origJson = res.json.bind(res);
      res.json = function interceptJson(body) {
        const statusCode = res.statusCode || 200;
        // Only cache successful (2xx) responses so that transient failures can
        // be retried with the same key.
        if (statusCode >= 200 && statusCode < 300) {
          redis
            .set(
              resultKey(key),
              JSON.stringify({ status: statusCode, body }),
              'EX',
              IDEMPOTENCY_TTL_SECONDS
            )
            .catch(err =>
              logger.warn('Failed to cache idempotency result', { scope, key, error: err.message })
            );
        }
        // Release the lock — the result is now persisted (or a 2xx result is
        // being written asynchronously above).
        redis.del(lockKey(key)).catch(() => {});
        return origJson(body);
      };

      return next();
    } catch (err) {
      // Fail open: Redis is unavailable, log and continue without idempotency.
      logger.error('Idempotency middleware Redis error; failing open', {
        scope,
        key,
        error: err.message,
      });
      return next();
    }
  };
}

module.exports = { idempotency, IDEMPOTENCY_KEY_HEADER };
