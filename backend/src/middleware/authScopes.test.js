const test = require('node:test');
const assert = require('node:assert/strict');
const { assertApiKeyScopes, isImpersonatedRestrictedAction } = require('./auth');

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
    },
  };
}

test('JWT auth bypasses scope checks', () => {
  const req = { originalUrl: '/api/withdrawals/request', method: 'POST', auth: { kind: 'jwt' } };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('read-only API key cannot POST withdrawals', () => {
  const req = {
    originalUrl: '/api/withdrawals/request',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), false);
  assert.equal(res.statusCode, 403);
});

test('API key with withdrawals scope can POST withdrawals', () => {
  const req = {
    originalUrl: '/api/withdrawals/request',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read', 'withdrawals'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('read-only API key can GET withdrawals', () => {
  const req = {
    originalUrl: '/api/withdrawals/campaign/x',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['read'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('developer scope required for api-keys routes', () => {
  const req = {
    originalUrl: '/api/api-keys',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['read', 'write', 'withdrawals'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), false);
  assert.equal(res.statusCode, 403);
});

test('developer scope required for /api/users/api-keys routes', () => {
  const req = {
    originalUrl: '/api/users/api-keys',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read', 'write', 'withdrawals'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), false);
  assert.equal(res.statusCode, 403);
});

test('full scope allows developer routes', () => {
  const req = {
    originalUrl: '/api/api-keys',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['full'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('read scope allows GET on v1 API', () => {
  const req = {
    originalUrl: '/api/v1/campaigns',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['read'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('read-only API key cannot POST v1 contributions', () => {
  const req = {
    originalUrl: '/api/v1/campaigns/x/contributions',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), false);
  assert.equal(res.statusCode, 403);
});

test('write scope allows POST on v1 API', () => {
  const req = {
    originalUrl: '/v1/campaigns/x/contributions',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read', 'write'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('impersonation mode blocks withdrawal mutations', () => {
  const req = {
    originalUrl: '/api/withdrawals/request',
    method: 'POST',
    auth: { kind: 'jwt', impersonated: true },
  };
  assert.equal(isImpersonatedRestrictedAction(req), true);
});

test('impersonation mode blocks destructive requests', () => {
  const req = {
    originalUrl: '/api/campaigns/camp-1',
    method: 'DELETE',
    auth: { kind: 'jwt', impersonated: true },
  };
  assert.equal(isImpersonatedRestrictedAction(req), true);
});

test('impersonation mode permits read-only requests', () => {
  const req = {
    originalUrl: '/api/campaigns/camp-1',
    method: 'GET',
    auth: { kind: 'jwt', impersonated: true },
  };
  assert.equal(isImpersonatedRestrictedAction(req), false);
});

test('impersonation mode permits its exit endpoint', () => {
  const req = {
    originalUrl: '/api/admin/impersonate/exit',
    method: 'POST',
    auth: { kind: 'jwt', impersonated: true },
  };
  assert.equal(isImpersonatedRestrictedAction(req), false);
});
