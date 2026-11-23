'use strict';

/**
 * Velocity limits for money-movement attempts (#1126).
 *
 * Withdrawals and refunds are privileged, hard-to-reverse actions. A single
 * compromised or misbehaving account should not be able to open an unbounded
 * number of requests in a short period. This module counts the request rows
 * an actor created inside a rolling window using the existing
 * `withdrawal_requests` / `refund_requests` tables — no schema change is
 * required and the limit cannot be bypassed by restarting the process
 * (unlike an in-memory counter).
 *
 * The module is intentionally dependency-free: callers pass the database
 * `query` function, which keeps it easy to unit test and avoids loading a
 * database connection at require time.
 */

const DEFAULT_LIMITS = Object.freeze({
  withdrawal: Object.freeze({ maxRequests: 5, windowSeconds: 60 * 60 }),
  refund: Object.freeze({ maxRequests: 10, windowSeconds: 60 * 60 }),
});

const SOURCES = Object.freeze({
  withdrawal: Object.freeze({
    table: 'withdrawal_requests',
    actorColumn: 'requested_by',
    envPrefix: 'WITHDRAWAL_VELOCITY',
    label: 'Withdrawal',
  }),
  refund: Object.freeze({
    table: 'refund_requests',
    actorColumn: 'contributor_id',
    envPrefix: 'REFUND_VELOCITY',
    label: 'Refund',
  }),
});

class VelocityLimitError extends Error {
  constructor(details) {
    super(`${details.label} velocity limit exceeded. Try again later.`);
    this.name = 'VelocityLimitError';
    this.code = 'VELOCITY_LIMIT_EXCEEDED';
    this.status = 429;
    this.retryAfterSeconds = details.windowSeconds;
    this.details = details;
  }
}

function sourceFor(kind) {
  const source = SOURCES[kind];
  if (!source) throw new Error(`Unknown velocity limit kind: ${kind}`);
  return source;
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Resolve the configured limit for a request kind.
 *
 * `maxRequests: 0` explicitly disables the limit (useful for local demos).
 * Invalid or negative values fall back to the secure default.
 */
function getVelocityLimit(kind, env = process.env) {
  const source = sourceFor(kind);
  const defaults = DEFAULT_LIMITS[kind];
  const maxRequests = positiveInt(env[`${source.envPrefix}_MAX_REQUESTS`], defaults.maxRequests);
  const windowSeconds = positiveInt(
    env[`${source.envPrefix}_WINDOW_SECONDS`],
    defaults.windowSeconds
  );
  return {
    kind,
    label: source.label,
    maxRequests,
    windowSeconds: windowSeconds > 0 ? windowSeconds : defaults.windowSeconds,
    enabled: maxRequests > 0,
  };
}

/**
 * Count how many requests an actor created within the rolling window.
 */
async function countRecentAttempts({ kind, actorId, query, now = new Date(), windowSeconds }) {
  const source = sourceFor(kind);
  if (typeof query !== 'function') throw new Error('velocityLimit: query function is required');

  const window = windowSeconds || getVelocityLimit(kind).windowSeconds;
  const cutoff = new Date(new Date(now).getTime() - window * 1000);
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
       FROM ${source.table}
      WHERE ${source.actorColumn} = $1 AND created_at >= $2`,
    [actorId, cutoff]
  );
  return Number(rows?.[0]?.count || 0);
}

/**
 * Evaluate the velocity limit without throwing. Returns a plain result object
 * so callers can decide how to surface a block.
 */
async function checkVelocityLimit({ kind, actorId, query, now = new Date(), env = process.env }) {
  const limit = getVelocityLimit(kind, env);

  // No actor (e.g. an unauthenticated request that somehow reached here) or a
  // deliberately disabled limit: nothing to enforce.
  if (!actorId || !limit.enabled) {
    return { ...limit, allowed: true, count: 0, skipped: !actorId || !limit.enabled };
  }

  const count = await countRecentAttempts({
    kind,
    actorId,
    query,
    now,
    windowSeconds: limit.windowSeconds,
  });

  return { ...limit, count, allowed: count < limit.maxRequests, skipped: false };
}

/**
 * Throw a VelocityLimitError (HTTP 429) when the actor is over the limit.
 * Returns the check result when allowed so callers can log/inspect it.
 */
async function assertVelocityLimit(options) {
  const result = await checkVelocityLimit(options);
  if (!result.allowed) throw new VelocityLimitError(result);
  return result;
}

module.exports = {
  DEFAULT_LIMITS,
  VelocityLimitError,
  getVelocityLimit,
  countRecentAttempts,
  checkVelocityLimit,
  assertVelocityLimit,
};
