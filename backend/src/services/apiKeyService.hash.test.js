'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

process.env.INTEGRATION_SECRET_LOCAL_KEK =
  process.env.INTEGRATION_SECRET_LOCAL_KEK || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const MODULE_PATH = './apiKeyService';

test('verifyApiKeyHash accepts a matching bcrypt hash and rejects a wrong key', async () => {
  const { verifyApiKeyHash } = require(MODULE_PATH);
  const rawKey = 'cpk_' + 'd'.repeat(64);
  const keyHash = await bcrypt.hash(rawKey, 4);

  assert.equal(await verifyApiKeyHash(rawKey, keyHash), true);
  assert.equal(await verifyApiKeyHash('cpk_' + 'e'.repeat(64), keyHash), false);
});

test('verifyApiKeyHash compares hex digests in constant time', async () => {
  const { verifyApiKeyHash } = require(MODULE_PATH);
  const rawKey = 'cpk_' + 'f'.repeat(64);
  const digest = crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');

  assert.equal(await verifyApiKeyHash(rawKey, digest), true);
  // Hex digests are case-insensitive.
  assert.equal(await verifyApiKeyHash(rawKey, digest.toUpperCase()), true);
  assert.equal(await verifyApiKeyHash('cpk_' + '0'.repeat(64), digest), false);
});

test('verifyApiKeyHash fails closed for unsupported or malformed hashes', async () => {
  const { verifyApiKeyHash } = require(MODULE_PATH);
  const rawKey = 'cpk_' + '1'.repeat(64);

  assert.equal(await verifyApiKeyHash(rawKey, ''), false);
  assert.equal(await verifyApiKeyHash(rawKey, 'not-a-hash'), false);
  // A bcrypt digest that cannot be parsed must not authenticate the key.
  assert.equal(await verifyApiKeyHash(rawKey, '$2a$10$broken'), false);
  assert.equal(await verifyApiKeyHash('', 'anything'), false);
  assert.equal(await verifyApiKeyHash(rawKey, null), false);
  assert.equal(await verifyApiKeyHash(rawKey, undefined), false);
});
