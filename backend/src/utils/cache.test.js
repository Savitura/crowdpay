const test = require('node:test');
const assert = require('node:assert/strict');

const cache = require('./cache');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('returns stored values and undefined for missing keys', () => {
  cache.set('cache-test:present', { ok: true }, 5_000);
  assert.deepEqual(cache.get('cache-test:present'), { ok: true });
  assert.equal(cache.get('cache-test:absent'), undefined);
});

test('expires entries once their TTL has passed', async () => {
  cache.set('cache-test:short', 'value', 5);
  assert.equal(cache.get('cache-test:short'), 'value');

  await wait(15);
  assert.equal(cache.get('cache-test:short'), undefined, 'entry is evicted after its TTL');
  assert.equal(cache.get('cache-test:short'), undefined, 'a second read stays empty');
});

test('invalidate removes a single key', () => {
  cache.set('cache-test:single', 1, 5_000);
  cache.invalidate('cache-test:single');
  assert.equal(cache.get('cache-test:single'), undefined);
});

test('invalidatePrefix removes only matching keys', () => {
  cache.set('cache-test:prefix:a', 1, 5_000);
  cache.set('cache-test:prefix:b', 2, 5_000);
  cache.set('cache-test:other', 3, 5_000);

  cache.invalidatePrefix('cache-test:prefix:');

  assert.equal(cache.get('cache-test:prefix:a'), undefined);
  assert.equal(cache.get('cache-test:prefix:b'), undefined);
  assert.equal(cache.get('cache-test:other'), 3);

  cache.invalidate('cache-test:other');
});

test('storing a key again replaces its value and TTL', async () => {
  cache.set('cache-test:replace', 'first', 5);
  cache.set('cache-test:replace', 'second', 5_000);

  await wait(15);
  assert.equal(cache.get('cache-test:replace'), 'second');

  cache.invalidate('cache-test:replace');
});
