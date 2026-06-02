/**
 * Simple in-process TTL cache backed by a Map.
 *
 * Suitable for single-instance MVP deployments. Not suitable for
 * multi-instance deployments where cache coherency across processes
 * is required — use Redis or a shared cache layer in that scenario.
 */
class TtlCache {
  constructor() {
    this._store = new Map();
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
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key) {
    this._store.delete(key);
  }

  /**
   * Remove all entries whose key starts with the given prefix.
   */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }
}

module.exports = new TtlCache();
