const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');
const jwt = require('jsonwebtoken');

// Set required env vars before importing modules
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'testsecret';
process.env.API_KEY_PEPPER = 'testpeppersecret';
process.env.JWT_ISSUER = 'https://crowdpay.io';
process.env.JWT_AUDIENCE = 'crowdpay-api';

const TEST_TOKEN = jwt.sign(
  { sub: 'user-123', iss: 'https://crowdpay.io', aud: 'crowdpay-api', userId: 'user-123', role: 'contributor' },
  'testsecret',
  { expiresIn: '1h' }
);

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createAuthModule({ dbRows = [], apiKeyRows = [], jwtSecret = 'testsecret', jwtIssuer = 'https://crowdpay.io', jwtAudience = 'crowdpay-api' } = {}) {
  return proxyquire('./auth', {
    jsonwebtoken: {
      verify: (token, secret) => {
        if (secret !== jwtSecret) throw new Error('Invalid signature');
        const payload = jwt.decode(token);
        if (!payload) throw new Error('Invalid token');
        return payload;
      },
    },
    '../config/database': {
      query: async (text, params) => {
        if (text?.includes('api_keys')) {
          return { rows: apiKeyRows };
        }
        return { rows: dbRows };
      },
    },
    '@sentry/node': {
      setUser: () => {},
    },
    '../services/apiKeyService': {
      authenticateCpkApiKey: async () => null,
    },
  });
}

test('requireAuth rejects banned users after loading auth state from the database', async () => {
  const { requireAuth } = createAuthModule({
    dbRows: [{ is_admin: false, is_banned: true }],
  });
  const req = {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    cookies: {},
    method: 'GET',
    originalUrl: '/api/users/me',
  };
  const res = mockRes();
  let nextCalled = false;

  await new Promise((resolve) => {
    requireAuth(req, res, () => {
      nextCalled = true;
      resolve();
    });
    setImmediate(resolve);
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Account suspended' });
});

test('requireAuth allows unbanned users and preserves immediate access restoration', async () => {
  const { requireAuth } = createAuthModule({
    dbRows: [{ is_admin: false, is_banned: false }],
  });
  const req = {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    cookies: {},
    method: 'GET',
    originalUrl: '/api/users/me',
  };
  const res = mockRes();

  await new Promise((resolve, reject) => {
    requireAuth(req, res, () => {
      try {
        assert.equal(res.statusCode, 0);
        assert.equal(req.user.is_banned, false);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

test('cp_live_ API key does not update last_used_at on GET requests', async () => {
  const { requireAuth } = createAuthModule({
    dbRows: [{ is_admin: false, is_banned: false }],
    apiKeyRows: [{ id: 'key-1', user_id: 'user-1', scopes: ['read'], expires_at: null, rotation_state: 'active', last_used_at: null }],
  });
  const req = {
    headers: { authorization: 'Bearer cp_live_testkey' },
    cookies: {},
    method: 'GET',
    originalUrl: '/api/campaigns',
  };
  const res = mockRes();

  await new Promise((resolve) => {
    requireAuth(req, res, () => {
      resolve();
    });
    setImmediate(resolve);
  });

  assert.equal(res.statusCode, 0);
});

test('cp_live_ API key updates last_used_at on POST requests', async () => {
  const { requireAuth } = createAuthModule({
    dbRows: [{ is_admin: false, is_banned: false }],
    apiKeyRows: [{ id: 'key-1', user_id: 'user-1', scopes: ['read', 'write'], expires_at: null, rotation_state: 'active', last_used_at: null }],
  });
  const req = {
    headers: { authorization: 'Bearer cp_live_testkey' },
    cookies: {},
    method: 'POST',
    originalUrl: '/api/campaigns',
  };
  const res = mockRes();

  await new Promise((resolve) => {
    requireAuth(req, res, () => {
      resolve();
    });
    setImmediate(resolve);
  });

  assert.equal(res.statusCode, 0);
});

test('cp_live_ API key throttles last_used_at updates within interval', async () => {
  const pastTime = new Date(Date.now() - 60 * 1000); // 1 minute ago
  const { requireAuth } = createAuthModule({
    dbRows: [{ is_admin: false, is_banned: false }],
    apiKeyRows: [{ id: 'key-1', user_id: 'user-1', scopes: ['read', 'write'], expires_at: null, rotation_state: 'active', last_used_at: pastTime }],
  });
  const req = {
    headers: { authorization: 'Bearer cp_live_testkey' },
    cookies: {},
    method: 'POST',
    originalUrl: '/api/campaigns',
  };
  const res = mockRes();

  await new Promise((resolve) => {
    requireAuth(req, res, () => {
      resolve();
    });
    setImmediate(resolve);
  });

  assert.equal(res.statusCode, 0);
});