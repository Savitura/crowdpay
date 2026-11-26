const test = require('node:test');
const assert = require('node:assert/strict');

const { getSimhash, simhashSimilarity } = require('./simhash');

test('returns a 64-bit hash of zeroes for empty input', () => {
  assert.equal(getSimhash(''), '0'.repeat(64));
  assert.equal(getSimhash(null), '0'.repeat(64));
  assert.equal(getSimhash(undefined), '0'.repeat(64));
});

test('produces a deterministic 64-character binary string', () => {
  const first = getSimhash('Books for Kaduna');
  const second = getSimhash('Books for Kaduna');

  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.match(first, /^[01]{64}$/);
});

test('ignores case and punctuation when hashing', () => {
  assert.equal(getSimhash('Clean Water!'), getSimhash('clean water'));
});

test('different text produces a different hash', () => {
  assert.notEqual(getSimhash('roof repair'), getSimhash('school books'));
});

test('similarity is 1 for identical hashes and 0 for invalid input', () => {
  const hash = getSimhash('community clinic');

  assert.equal(simhashSimilarity(hash, hash), 1);
  assert.equal(simhashSimilarity(hash, ''), 0);
  assert.equal(simhashSimilarity(null, hash), 0);
  assert.equal(simhashSimilarity('short', hash), 0);
});

test('near-duplicate text scores higher than unrelated text', () => {
  const base = getSimhash('emergency shelter for displaced families in Gaza');
  const near = getSimhash('emergency shelter for displaced families in Gaza today');
  const far = getSimhash('solar panels for the village school');

  const nearScore = simhashSimilarity(base, near);
  const farScore = simhashSimilarity(base, far);

  assert.ok(nearScore > farScore, `${nearScore} should beat ${farScore}`);
  assert.ok(nearScore > 0.5);
});
