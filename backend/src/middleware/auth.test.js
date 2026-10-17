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
  {
    sub: 'user-123',
    iss: 'https://crowdpay.io',
    aud: 'crowdpay-api',
    userId: 'user-123',
    role: 'contributor',
  },
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

function createAuthModule({
  dbRows = [],
  jwtSecret = 'testsecret',
  jwtIssuer = 'https://crowdpay.io',
  jwtAudience = 'crowdpay-api',
} = {}) {
  return proxyquire('./auth', {
    jsonwebtoken: {
      verify: (token, secret, options) => {
        assert.deepEqual(options, { algorithms: ['HS256'] });
        if (secret !== jwtSecret) throw new Error('Invalid signature');
        const payload = jwt.decode(token);
        if (!payload) throw new Error('Invalid token');
        return payload;
      },
    },
    '../config/database': {
      query: async () => ({ rows: dbRows }),
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

  await new Promise(resolve => {
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

test('requireAuth rejects the obsolete cp_live_ API-key prefix', async () => {
  const { requireAuth } = createAuthModule();
  const req = {
    headers: { authorization: 'Bearer cp_live_testkey' },
    cookies: {},
    method: 'GET',
    originalUrl: '/api/campaigns',
  };
  const res = mockRes();

  await new Promise(resolve => {
    requireAuth(req, res, resolve);
    setImmediate(resolve);
  });

  assert.equal(res.statusCode, 401);
});
