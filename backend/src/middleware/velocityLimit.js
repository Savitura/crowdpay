'use strict';

const defaultLogger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');
const { assertVelocityLimit, VelocityLimitError } = require('../services/velocityLimitService');

/**
 * Build an Express middleware that rejects a money-movement request when the
 * authenticated actor has exceeded the configured rolling-window limit.
 *
 * The database `query` function is injected so route tests that replace
 * `../config/database` keep working and so this middleware has no hidden
 * connection dependency.
 *
 * Non-velocity errors are forwarded to the route error handler (HTTP 500) —
 * the request would fail on the same database anyway, so silently allowing it
 * would only mask an outage.
 */
function createVelocityLimit({
  kind,
  actorId,
  query,
  now = () => new Date(),
  env = process.env,
  logger = defaultLogger,
} = {}) {
  if (typeof actorId !== 'function') throw new Error('velocityLimit: actorId selector is required');
  if (typeof query !== 'function') throw new Error('velocityLimit: query function is required');

  return asyncHandler(async (req, res, next) => {
    const actor = actorId(req);
    try {
      const result = await assertVelocityLimit({ kind, actorId: actor, query, now: now(), env });
      if (res.locals) {
        res.locals.velocityLimit = {
          kind: result.kind,
          count: result.count,
          max_requests: result.maxRequests,
          window_seconds: result.windowSeconds,
        };
      }
      return next();
    } catch (error) {
      if (!(error instanceof VelocityLimitError)) throw error;

      const details = error.details;
      logger.warn('Velocity limit exceeded', {
        kind: details.kind,
        actor_id: actor,
        method: req.method,
        path: req.originalUrl || req.path,
        count: details.count,
        max_requests: details.maxRequests,
        window_seconds: details.windowSeconds,
      });

      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too Many Requests',
        code: error.code,
        message: `${details.label} velocity limit exceeded. Please try again later.`,
        retry_after: error.retryAfterSeconds,
        limit: details.maxRequests,
        window_seconds: details.windowSeconds,
      });
    }
  });
}

module.exports = { createVelocityLimit };
