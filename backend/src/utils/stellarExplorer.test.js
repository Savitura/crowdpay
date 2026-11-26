const test = require('node:test');
const assert = require('node:assert/strict');

const { getStellarExpertTxUrl } = require('./stellarExplorer');

const HASH = 'f'.repeat(64);

test('defaults to the testnet explorer', () => {
  const previous = process.env.STELLAR_NETWORK;
  delete process.env.STELLAR_NETWORK;

  assert.equal(
    getStellarExpertTxUrl(HASH),
    `https://stellar.expert/explorer/testnet/tx/${HASH}`
  );

  if (previous !== undefined) process.env.STELLAR_NETWORK = previous;
});

test('uses the configured network', () => {
  const previous = process.env.STELLAR_NETWORK;
  process.env.STELLAR_NETWORK = 'public';

  assert.equal(
    getStellarExpertTxUrl(HASH),
    `https://stellar.expert/explorer/public/tx/${HASH}`
  );

  if (previous === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = previous;
});

test('keeps the hash intact in the URL', () => {
  assert.ok(getStellarExpertTxUrl(HASH).endsWith(`/tx/${HASH}`));
});
