'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signEmbedToken, verifyEmbedToken, validateOrigin } = require('./embedTokenJwtService');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-jwt-service-tests-32';

test('embedTokenJwtService sign and verify embed token', () => {
  const token = signEmbedToken({ campaignId: 'c-1', allowedOrigins: ['https://example.com'] });
  assert.equal(typeof token, 'string');

  const payload = verifyEmbedToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, 'c-1');

  const invalid = verifyEmbedToken('invalid.jwt.token');
  assert.equal(invalid, null);
});

test('embedTokenJwtService validateOrigin works correctly', () => {
  assert.equal(validateOrigin('https://example.com', ['https://example.com']), true);
  assert.equal(validateOrigin('https://evil.com', ['https://example.com']), false);
  assert.equal(validateOrigin('https://any.com', ['*']), true);
});
