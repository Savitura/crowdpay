const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

// Complements backend/src/routes/wallets.test.js (from PR #466, which covers the
// happy path, 400 no-secret, 404 unknown campaign, and 403 non-owner). This file
// covers the controls added for issue #471: 401 unauthenticated, owner-or-admin
// access, rate limiting, and audit logging on /recover.

// wallets.js reads process.env.NODE_ENV once, at require time, to size its rate
// limiter. Force NODE_ENV to 'test' here so this file's assertions hold regardless
// of how it's invoked (npm test vs. a direct `node --test` on this file), matching
// what npm test's env wrapper already guarantees. Restored after all tests in this
// file run so nothing leaks to a process that reuses this env (e.g. a direct,
// single-file `node --test` invocation of multiple suites).
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
test.after(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

function buildApp({
  queryImpl,
  authUser,
  authError,
  rateLimitStub,
  stellarServiceImpl = {},
  walletServiceImpl = {},
} = {}) {
  const logCalls = [];
  const router = proxyquire('./wallets', {
    '../config/database': {
      query: queryImpl,
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (authError) {
          return res.status(401).json({ error: authError });
        }
        req.user = authUser || { userId: 'owner-1', role: 'creator' };
        next();
      },
    },
    './admin': {
      logAdminAction: async (...args) => {
        logCalls.push(args);
      },
    },
    '../services/stellarService': {
      getAccountMultisigConfig: async () => ({ signers: [], thresholds: {} }),
      getWalletTransactionHistory: async () => [],
      getWalletPayments: async () => [],
      recoverWalletFromSecret: () => ({ publicKey: 'GRECOVEREDPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      ...stellarServiceImpl,
    },
    '../services/walletService': {
      decryptSecret: () => 'SFAKESECRETSEEDVALUENOTREALNOTREALNOTREALNOTREALNOTRE',
      ...walletServiceImpl,
    },
    ...(rateLimitStub ? { 'express-rate-limit': rateLimitStub } : {}),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/wallets', router);
  return { app, logCalls };
}

// --- 401 unauthenticated ---

test('GET /:campaignId/config returns 401 when unauthenticated', async () => {
  const { app } = buildApp({ authError: 'Missing token' });
  const res = await request(app).get('/api/wallets/camp-1/config');
  assert.equal(res.status, 401);
});

test('GET /:campaignId/transactions returns 401 when unauthenticated', async () => {
  const { app } = buildApp({ authError: 'Missing token' });
  const res = await request(app).get('/api/wallets/camp-1/transactions');
  assert.equal(res.status, 401);
});

test('GET /:campaignId/payments returns 401 when unauthenticated', async () => {
  const { app } = buildApp({ authError: 'Missing token' });
  const res = await request(app).get('/api/wallets/camp-1/payments');
  assert.equal(res.status, 401);
});

test('POST /:campaignId/recover returns 401 when unauthenticated', async () => {
  const { app } = buildApp({ authError: 'Missing token' });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 401);
});

// --- owner-or-admin access ---

test('GET /:campaignId/config allows an admin who does not own the campaign', async () => {
  const { app } = buildApp({
    authUser: { userId: 'admin-1', role: 'admin' },
    queryImpl: async () => ({ rows: [{ wallet_public_key: 'GPUBKEY', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).get('/api/wallets/camp-1/config');
  assert.equal(res.status, 200);
});

test('GET /:campaignId/transactions allows an admin who does not own the campaign', async () => {
  const { app } = buildApp({
    authUser: { userId: 'admin-1', role: 'admin' },
    queryImpl: async () => ({ rows: [{ wallet_public_key: 'GPUBKEY', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).get('/api/wallets/camp-1/transactions');
  assert.equal(res.status, 200);
});

test('GET /:campaignId/payments allows an admin who does not own the campaign', async () => {
  const { app } = buildApp({
    authUser: { userId: 'admin-1', role: 'admin' },
    queryImpl: async () => ({ rows: [{ wallet_public_key: 'GPUBKEY', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).get('/api/wallets/camp-1/payments');
  assert.equal(res.status, 200);
});

test('POST /:campaignId/recover allows an admin who does not own the campaign', async () => {
  const { app, logCalls } = buildApp({
    authUser: { userId: 'admin-1', role: 'admin' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: 'ENCRYPTEDBLOB', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 200);
  assert.equal(res.body.publicKey, 'GRECOVEREDPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(logCalls.length, 1);
});

test('POST /:campaignId/recover still rejects a non-owner, non-admin user', async () => {
  const { app, logCalls } = buildApp({
    authUser: { userId: 'stranger-1', role: 'contributor' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: 'ENCRYPTEDBLOB', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 403);
  assert.equal(logCalls.length, 1);
});

// --- audit logging on /recover ---

test('POST /:campaignId/recover logs a denied attempt for a non-owner, non-admin requester', async () => {
  const { app, logCalls } = buildApp({
    authUser: { userId: 'stranger-1', role: 'contributor' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: 'ENCRYPTEDBLOB', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 403);

  assert.equal(logCalls.length, 1);
  const [adminUserId, actionType, targetType, targetId, details] = logCalls[0];
  assert.equal(adminUserId, 'stranger-1');
  assert.equal(actionType, 'wallet_recover');
  assert.equal(targetType, 'campaign');
  assert.equal(targetId, 'camp-1');
  assert.equal(details.outcome, 'denied');
  assert.equal(details.requesterId, 'stranger-1');
  assert.equal(details.campaignId, 'camp-1');
});

test('POST /:campaignId/recover logs a success attempt for the owner', async () => {
  const { app, logCalls } = buildApp({
    authUser: { userId: 'owner-1', role: 'creator' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: 'ENCRYPTEDBLOB', creator_id: 'owner-1' }] }),
  });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 200);

  assert.equal(logCalls.length, 1);
  const [adminUserId, actionType, targetType, targetId, details] = logCalls[0];
  assert.equal(adminUserId, 'owner-1');
  assert.equal(actionType, 'wallet_recover');
  assert.equal(targetType, 'campaign');
  assert.equal(targetId, 'camp-1');
  assert.equal(details.outcome, 'success');
  assert.equal(details.requesterId, 'owner-1');
});

test('POST /:campaignId/recover does not write an audit entry when there is no stored secret', async () => {
  const { app, logCalls } = buildApp({
    authUser: { userId: 'owner-1', role: 'creator' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: null, creator_id: 'owner-1' }] }),
  });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 400);
  assert.equal(logCalls.length, 0);
});

test('POST /:campaignId/recover audit details never include the decrypted secret or key material', async () => {
  const { app, logCalls } = buildApp({
    authUser: { userId: 'owner-1', role: 'creator' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: 'ENCRYPTEDBLOB', creator_id: 'owner-1' }] }),
    walletServiceImpl: { decryptSecret: () => 'SSUPERSECRETSEEDVALUENOTREALNOTREALNOTREALNOTREALNOTR' },
  });
  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 200);

  const details = logCalls[0][4];
  const serialized = JSON.stringify(details);
  assert.ok(!serialized.includes('SSUPERSECRETSEEDVALUENOTREALNOTREALNOTREALNOTREALNOTR'));
  assert.ok(!serialized.includes(res.body.publicKey));
  assert.deepEqual(Object.keys(details).sort(), ['campaignId', 'outcome', 'requesterId']);
});

// --- rate limiting on /recover ---
//
// The route wires up a module-level `rateLimit(...)` call at require time, and
// `isTest` is read from process.env.NODE_ENV once, at that same moment. Rather than
// flip NODE_ENV around real requests (which risks leaking into other tests running
// in this process) or trying to force a genuine 429 while NODE_ENV=test disables the
// limiter, we proxyquire 'express-rate-limit' with a stub that just records the
// config object it was constructed with, and assert on that. The one place we do
// toggle NODE_ENV, we do it synchronously around a single proxyquire call with no
// `await` in between, so no other test can observe the mutated value.

test('recover rate limiter is constructed mirroring the contributions.js limiter shape', () => {
  let capturedConfig = null;
  const rateLimitStub = (config) => {
    capturedConfig = config;
    return (req, res, next) => next();
  };

  proxyquire('./wallets', {
    'express-rate-limit': rateLimitStub,
    '../config/database': { query: async () => ({ rows: [] }) },
    '../middleware/auth': { requireAuth: (req, res, next) => next() },
    './admin': { logAdminAction: async () => {} },
    '../services/stellarService': {},
    '../services/walletService': {},
  });

  assert.ok(capturedConfig);
  assert.equal(capturedConfig.windowMs, 60 * 1000);
  assert.equal(capturedConfig.standardHeaders, true);
  assert.equal(capturedConfig.legacyHeaders, false);
  assert.deepEqual(capturedConfig.message, { error: 'Too many requests, please try again later.' });
  assert.equal(typeof capturedConfig.skip, 'function');
  // NODE_ENV is forced to 'test' at the top of this file, so isTest is true here.
  assert.equal(capturedConfig.max, 100000);
  assert.equal(capturedConfig.skip(), true);
});

test('recover rate limiter caps at 3/min outside test mode', () => {
  let capturedConfig = null;
  const rateLimitStub = (config) => {
    capturedConfig = config;
    return (req, res, next) => next();
  };

  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    proxyquire('./wallets', {
      'express-rate-limit': rateLimitStub,
      '../config/database': { query: async () => ({ rows: [] }) },
      '../middleware/auth': { requireAuth: (req, res, next) => next() },
      './admin': { logAdminAction: async () => {} },
      '../services/stellarService': {},
      '../services/walletService': {},
    });
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }

  assert.ok(capturedConfig);
  assert.equal(capturedConfig.max, 3);
  assert.equal(capturedConfig.skip(), false);
});

test('POST /:campaignId/recover runs requests through the rate limiter middleware', async () => {
  let limiterInvocations = 0;
  const rateLimitStub = () => (req, res, next) => {
    limiterInvocations += 1;
    next();
  };
  const { app } = buildApp({
    authUser: { userId: 'owner-1', role: 'creator' },
    queryImpl: async () => ({ rows: [{ wallet_secret_encrypted: 'ENCRYPTEDBLOB', creator_id: 'owner-1' }] }),
    rateLimitStub,
  });

  const res = await request(app).post('/api/wallets/camp-1/recover');
  assert.equal(res.status, 200);
  assert.equal(limiterInvocations, 1);
});
