const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');

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

function createMiddleware({ dbRows }) {
  return proxyquire('./auth', {
    jsonwebtoken: {
      verify: () => ({ userId: 'user-123', role: 'contributor' }),
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
  const { requireAuth } = createMiddleware({
    dbRows: [{ is_admin: false, is_banned: true }],
  });
  const req = {
    headers: { authorization: 'Bearer test-token' },
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
  const { requireAuth } = createMiddleware({
    dbRows: [{ is_admin: false, is_banned: false }],
  });
  const req = {
    headers: { authorization: 'Bearer test-token' },
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
