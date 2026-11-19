'use strict';

const crypto = require('crypto');

/**
 * Tamper-evident hash chain for financial audit events.
 *
 * Each audit event is canonicalized to deterministic JSON and hashed with
 * SHA-256 together with the previous event's hash. This forms an append-only
 * chain: any modification of a past event changes its hash and invalidates
 * every derived hash after it.
 *
 * The canonicalization rules are versioned so the algorithm can evolve
 * without invalidating historical entries. The version is stored on each
 * row (`hash_version`) and is part of the hash preimage.
 */

const GENESIS = 'GENESIS';
const HASH_VERSION = 1;

const HASH_FIELDS = [
  'id',
  'actor_id',
  'action',
  'resource_type',
  'resource_id',
  'correlation_id',
  'source',
  'metadata',
  'created_at',
];

/**
 * Recursively sort object keys so two equivalent objects serialize to
 * identical bytes regardless of insertion order. Arrays preserve order.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

/**
 * Normalize a raw audit row into the canonical event shape used for
 * hashing. Only the fields that are part of the audit record are included,
 * so incidental columns (e.g. created_at timezone formatting) cannot cause
 * false positives.
 */
function normalizeEvent(event) {
  const out = {};
  for (const field of HASH_FIELDS) {
    if (event[field] !== undefined) {
      out[field] = event[field];
    }
  }
  return out;
}

/**
 * Compute the tamper-evident hash for a single audit event.
 *
 * @param {string} prevHash - hash of the previous chain entry (GENESIS for the first).
 * @param {Object} event - the audit event row.
 * @param {number} [version=HASH_VERSION] - canonicalization version.
 * @returns {string} hex-encoded SHA-256 digest.
 */
function computeEventHash(prevHash, event, version = HASH_VERSION) {
  if (typeof prevHash !== 'string' || prevHash.length === 0) {
    throw new Error('auditHash: prevHash must be a non-empty string');
  }
  if (!event || typeof event !== 'object') {
    throw new Error('auditHash: event must be an object');
  }
  const payload = {
    v: version,
    prev: prevHash,
    event: canonicalize(normalizeEvent(event)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Verify a sequence of audit rows (ordered by chain_seq ascending).
 *
 * Rows with a NULL `event_hash` are treated as pre-chain historical data
 * and are skipped. The chain is verified from the first hashed row onward.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @param {string} [options.expectedPrevHash] - expected prev_hash of the first hashed row.
 * @returns {Object} { valid, checked, brokenAt, reason }
 */
function verifyChain(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('auditHash: rows must be an array');
  }
  const hashed = rows.filter((r) => r && r.event_hash != null);
  if (hashed.length === 0) {
    return { valid: true, checked: 0, brokenAt: null, reason: null };
  }

  let expectedPrev = options.expectedPrevHash || hashed[0].prev_hash;
  if (!expectedPrev) {
    return {
      valid: false,
      checked: 0,
      brokenAt: null,
      reason: 'missing_prev_hash',
    };
  }

  for (let i = 0; i < hashed.length; i++) {
    const row = hashed[i];
    if (row.prev_hash !== expectedPrev) {
      return {
        valid: false,
        checked: i,
        brokenAt: row.id ?? row.chain_seq ?? null,
        reason: 'prev_hash_mismatch',
      };
    }
    const version = row.hash_version ?? HASH_VERSION;
    const recomputed = computeEventHash(row.prev_hash, row, version);
    if (recomputed !== row.event_hash) {
      return {
        valid: false,
        checked: i,
        brokenAt: row.id ?? row.chain_seq ?? null,
        reason: 'event_hash_mismatch',
      };
    }
    expectedPrev = row.event_hash;
  }

  return { valid: true, checked: hashed.length, brokenAt: null, reason: null };
}

module.exports = {
  GENESIS,
  HASH_VERSION,
  HASH_FIELDS,
  canonicalize,
  normalizeEvent,
  computeEventHash,
  verifyChain,
};
