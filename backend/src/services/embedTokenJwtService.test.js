'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const embedTokenJwtService = require('./embedTokenJwtService');

test('embedTokenJwtService generates and verifies embed tokens', async () => {
  const payload = { sub: 'campaign-1', user_id: 'user-1' };
  const token = embedTokenJwtService.generateEmbedToken(payload);
  assert.ok(typeof token === 'string');

  const verified = embedTokenJwtService.verifyEmbedToken(token);
  assert.equal(verified.sub, 'campaign-1');
  assert.equal(verified.user_id, 'user-1');
});

test('embedTokenJwtService returns null for invalid or tampered tokens', async () => {
  const verified = embedTokenJwtService.verifyEmbedToken('invalid.token.string');
  assert.equal(verified, null);
});
