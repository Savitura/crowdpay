const test = require('node:test');
const assert = require('node:assert/strict');
const { equalFixedLength, equalSha256Hex } = require('./constantTime');

test('fixed-length comparisons accept matches and reject differences and lengths', () => {
  assert.equal(equalFixedLength(Buffer.from('hash'), Buffer.from('hash')), true);
  assert.equal(equalFixedLength(Buffer.from('hash'), Buffer.from('hAsh')), false);
  assert.equal(equalFixedLength(Buffer.from('hash'), Buffer.from('has')), false);
});

test('SHA-256 verification rejects malformed, truncated and appended signatures', () => {
  const digest = 'ab'.repeat(32);
  assert.equal(equalSha256Hex(digest, digest), true);
  assert.equal(equalSha256Hex(digest.toUpperCase(), digest), true);
  for (const value of [
    null,
    '',
    digest.slice(1),
    digest + '0',
    digest + 'zz',
    'gg'.repeat(32),
    'cd'.repeat(32),
  ]) {
    assert.equal(equalSha256Hex(value, digest), false);
  }
});
