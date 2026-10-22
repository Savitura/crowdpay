/**
 * Simple in-process TTL cache backed by a Map.
 *
 * Suitable for single-instance MVP deployments. Not suitable for
 * multi-instance deployments where cache coherency across processes
 * is required — use Redis or a shared cache layer in that scenario.
 */
class TtlCache {
  constructor(defaultTtlMs = 60_000) {
    this._defaultTtlMs = defaultTtlMs;
    this._store = new Map();
    this._inflight = new Map();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this._defaultTtlMs),
    });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  async wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }

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

  invalidate(key) {
    this._store.delete(key);
    this._inflight.delete(key);
  }

  /**
   * Remove all entries whose key starts with the given prefix.
   */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
    for (const key of this._inflight.keys()) {
      if (key.startsWith(prefix)) this._inflight.delete(key);
    }
  }

  clear() {
    this._store.clear();
    this._inflight.clear();
  }
}

module.exports = new TtlCache();
