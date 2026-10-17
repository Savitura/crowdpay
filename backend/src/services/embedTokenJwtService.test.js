'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const embedTokenJwtService = require('./embedTokenJwtService');

test('signEmbedToken generates a token verifiable back to its campaign and origins', () => {
  const token = embedTokenJwtService.signEmbedToken({
    campaignId: 'campaign-1',
    allowedOrigins: ['https://example.com'],
  });
  assert.ok(typeof token === 'string');

  const verified = embedTokenJwtService.verifyEmbedToken(token);
  assert.equal(verified.sub, 'campaign-1');
  assert.deepEqual(verified.origins, ['https://example.com']);
});

test('verifyEmbedToken returns null for invalid or tampered tokens', () => {
  const verified = embedTokenJwtService.verifyEmbedToken('invalid.token.string');
  assert.equal(verified, null);
});

test('signMilestoneWidgetToken scopes the token to milestones:read', () => {
  const token = embedTokenJwtService.signMilestoneWidgetToken({
    campaignId: 'campaign-1',
    allowedOrigins: ['https://example.com'],
  });
  const verified = embedTokenJwtService.verifyEmbedToken(token);
  assert.equal(verified.scope, 'milestones:read');
});

test('validateOrigin accepts an exact match and a wildcard, rejects everything else', () => {
  assert.equal(
    embedTokenJwtService.validateOrigin('https://example.com', ['https://example.com']),
    true
  );
  assert.equal(embedTokenJwtService.validateOrigin('https://evil.com', ['*']), true);
  assert.equal(
    embedTokenJwtService.validateOrigin('https://evil.com', ['https://example.com']),
    false
  );
  assert.equal(embedTokenJwtService.validateOrigin(null, ['https://example.com']), false);
});
