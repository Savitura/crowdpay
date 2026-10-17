'use strict';

/**
 * TtlCache unit tests — no DB or network required.
 * Run: NODE_ENV=test node --test src/utils/TtlCache.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TtlCache } = require('./TtlCache');

// ---------------------------------------------------------------------------
// get / set / has
// ---------------------------------------------------------------------------
describe('TtlCache — get/set/has', () => {
  it('returns undefined for missing keys', () => {
    const cache = new TtlCache(1000);
    assert.equal(cache.get('missing'), undefined);
  });

  it('stores and retrieves a value', () => {
    const cache = new TtlCache(1000);
    cache.set('key', 42);
    assert.equal(cache.get('key'), 42);
  });

  it('has() returns true for a live entry', () => {
    const cache = new TtlCache(1000);
    cache.set('x', 'hello');
    assert.equal(cache.has('x'), true);
  });

  it('has() returns false for a missing entry', () => {
    const cache = new TtlCache(1000);
    assert.equal(cache.has('nope'), false);
  });

  it('stores falsy values correctly (0, false, null, empty string)', () => {
    const cache = new TtlCache(1000);
    cache.set('zero', 0);
    cache.set('false', false);
    cache.set('null', null);
    cache.set('empty', '');
    // All should be returned as-is; 0/false/null/''/[] are truthy checks
    // that would incorrectly bypass cache — verify we handle them
    assert.equal(cache.get('zero'), 0);
    assert.equal(cache.get('false'), false);
    assert.equal(cache.get('null'), null);
    assert.equal(cache.get('empty'), '');
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------
describe('TtlCache — TTL expiry', () => {
  it('returns undefined after TTL expires', async () => {
    const cache = new TtlCache(50); // 50ms TTL
    cache.set('k', 'value');
    assert.equal(cache.get('k'), 'value');

    await new Promise(r => setTimeout(r, 80));
    assert.equal(cache.get('k'), undefined);
  });

  it('per-entry TTL overrides the default', async () => {
    const cache = new TtlCache(5000); // long default
    cache.set('short', 'x', 40); // 40ms override
    assert.equal(cache.get('short'), 'x');

    await new Promise(r => setTimeout(r, 70));
    assert.equal(cache.get('short'), undefined);
  });

  it('size excludes expired entries', async () => {
    const cache = new TtlCache(50);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.size, 2);

    await new Promise(r => setTimeout(r, 80));
    assert.equal(cache.size, 0);
  });
});

// ---------------------------------------------------------------------------
// wrap()
// ---------------------------------------------------------------------------
describe('TtlCache — wrap()', () => {
  it('calls the factory on cache miss', async () => {
    const cache = new TtlCache(1000);
    let calls = 0;
    const result = await cache.wrap('k', async () => {
      calls++;
      return 'value';
    });
    assert.equal(result, 'value');
    assert.equal(calls, 1);
  });

  it('returns cached value without calling the factory again', async () => {
    const cache = new TtlCache(1000);
    let calls = 0;
    await cache.wrap('k', async () => {
      calls++;
      return 99;
    });
    const second = await cache.wrap('k', async () => {
      calls++;
      return 99;
    });
    assert.equal(second, 99);
    assert.equal(calls, 1); // factory called exactly once
  });

  it('re-calls the factory after TTL expires', async () => {
    const cache = new TtlCache(40); // 40ms
    let calls = 0;
    await cache.wrap('k', async () => {
      calls++;
      return 1;
    });
    await new Promise(r => setTimeout(r, 70));
    await cache.wrap('k', async () => {
      calls++;
      return 2;
    });
    assert.equal(calls, 2);
  });

  it('does not cache when the factory throws', async () => {
    const cache = new TtlCache(1000);
    let calls = 0;
    const failing = () =>
      cache.wrap('k', async () => {
        calls++;
        throw new Error('oops');
      });
    await assert.rejects(failing, /oops/);
    await assert.rejects(failing, /oops/); // second call also hits the factory
    assert.equal(calls, 2);
  });

  it('prevents thundering herd — concurrent callers share one in-flight promise', async () => {
    const cache = new TtlCache(1000);
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise(r => setTimeout(r, 20));
      return 'shared';
    };

    const [r1, r2, r3] = await Promise.all([
      cache.wrap('k', factory),
      cache.wrap('k', factory),
      cache.wrap('k', factory),
    ]);

    assert.equal(r1, 'shared');
    assert.equal(r2, 'shared');
    assert.equal(r3, 'shared');
    assert.equal(calls, 1); // factory was only called once despite 3 concurrent callers
  });
});

// ---------------------------------------------------------------------------
// invalidate / invalidatePrefix / clear
// ---------------------------------------------------------------------------
describe('TtlCache — invalidation', () => {
  it('invalidate() removes a single key', () => {
    const cache = new TtlCache(1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate('a');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
  });

  it('invalidatePrefix() removes all matching keys', () => {
    const cache = new TtlCache(1000);
    cache.set('admin:stats', 1);
    cache.set('admin:health', 2);
    cache.set('campaigns:featured', 3);
    cache.invalidatePrefix('admin:');
    assert.equal(cache.get('admin:stats'), undefined);
    assert.equal(cache.get('admin:health'), undefined);
    assert.equal(cache.get('campaigns:featured'), 3); // untouched
  });

  it('clear() removes all entries', () => {
    const cache = new TtlCache(1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('a'), undefined);
  });
});

// ---------------------------------------------------------------------------
// size
// ---------------------------------------------------------------------------
describe('TtlCache — size', () => {
  it('size reflects current live entry count', () => {
    const cache = new TtlCache(1000);
    assert.equal(cache.size, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.size, 2);
    cache.invalidate('a');
    assert.equal(cache.size, 1);
  });
});
