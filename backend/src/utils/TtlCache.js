'use strict';

/**
 * TtlCache — a lightweight, process-scoped TTL cache.
 *
 * Stores arbitrary values by string key. Each entry expires after `defaultTtlMs`
 * unless overridden per-call. No external dependencies; safe to use in any
 * Node.js module.
 *
 * Usage:
 *   const { TtlCache } = require('../utils/TtlCache');
 *   const cache = new TtlCache(30_000); // 30-second default TTL
 *
 *   const value = await cache.wrap('key', () => expensiveQuery(), 60_000);
 *   cache.invalidate('key');
 *   cache.invalidatePrefix('admin:');
 *   cache.clear();
 */
class TtlCache {
  /**
   * @param {number} defaultTtlMs  Default TTL in milliseconds (default 30 s)
   */
  constructor(defaultTtlMs = 30_000) {
    this._defaultTtlMs = defaultTtlMs;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this._store = new Map();
  }

  // ---------------------------------------------------------------------------
  // Core read / write
  // ---------------------------------------------------------------------------

  /**
   * Return the cached value for `key`, or undefined if missing / expired.
   * @param {string} key
   * @returns {any|undefined}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Store `value` under `key` for `ttlMs` milliseconds.
   * @param {string}  key
   * @param {any}     value
   * @param {number}  [ttlMs]  Overrides defaultTtlMs for this entry
   */
  set(key, value, ttlMs) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this._defaultTtlMs),
    });
  }

  /**
   * Return whether a valid (non-expired) entry exists for `key`.
   * @param {string} key
   */
  has(key) {
    return this.get(key) !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the cached value for `key`, or call `fn()`, cache the result, and
   * return it. Concurrent callers share the same in-flight promise (thundering-
   * herd prevention).
   *
   * @template T
   * @param {string}            key
   * @param {() => Promise<T>}  fn      Async factory called on cache miss
   * @param {number}            [ttlMs] Overrides defaultTtlMs for this entry
   * @returns {Promise<T>}
   */
  async wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    // Thundering-herd guard: reuse in-flight promises
    if (this._inflight && this._inflight.has(key)) {
      return this._inflight.get(key);
    }
    if (!this._inflight) this._inflight = new Map();

    const promise = Promise.resolve()
      .then(() => fn())
      .then(result => {
        this.set(key, result, ttlMs);
        this._inflight.delete(key);
        return result;
      })
      .catch(err => {
        this._inflight.delete(key);
        throw err;
      });

    this._inflight.set(key, promise);
    return promise;
  }

  /**
   * Remove a single key.
   * @param {string} key
   */
  invalidate(key) {
    this._store.delete(key);
  }

  /**
   * Remove all keys whose string starts with `prefix`.
   * @param {string} prefix
   */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  /**
   * Remove all cached entries.
   */
  clear() {
    this._store.clear();
  }

  /**
   * Return the number of non-expired entries currently in the cache.
   */
  get size() {
    const now = Date.now();
    let count = 0;
    for (const entry of this._store.values()) {
      if (now <= entry.expiresAt) count++;
    }
    return count;
  }
}

module.exports = { TtlCache };
