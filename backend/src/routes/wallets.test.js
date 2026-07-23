// NOTE: backend/src/routes/wallets.js is not mounted anywhere in src/index.js
// (verified: no `app.use` references it, no other module requires it). These
// tests exercise the router in isolation, the same way other route test files
// in this repo do — they do NOT prove the routes are reachable end-to-end in
// the running app. See PR description for details.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
// Fake, obviously-non-real Stellar-shaped public key used only as a stand-in string.
const FAKE_WALLET_PUBLIC_KEY = 'GFAKEWALLETPUBLICKEYFORTESTINGONLY0000000000000000000000';
const FAKE_ENCRYPTED_SECRET = 'fake:ciphertext:for-tests-only';
const FAKE_DECRYPTED_SECRET = 'fake-decrypted-secret-for-tests-only';

function buildApp({ queryImpl, stellarImpl, walletServiceImpl, userId = 'creator-1', role = 'creator' } = {}) {
  const stellarStub = {
    getAccountMultisigConfig: async () => ({
      thresholds: { med_threshold: 2 },
      signers: [{ key: 'GSIGNERFAKE', weight: 1 }],
    }),
    getWalletTransactionHistory: async () => [],
    getWalletPayments: async () => [],
    recoverWalletFromSecret: (secret) => ({ publicKey: FAKE_WALLET_PUBLIC_KEY, secret }),
    ...stellarImpl,
  };
  const walletServiceStub = {
    decryptSecret: (encrypted) => `decrypted(${encrypted})`,
    ...walletServiceImpl,
  };

  const router = proxyquire('./wallets', {
    '../config/database': { query: queryImpl },
    '../services/stellarService': stellarStub,
    '../services/walletService': walletServiceStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId, role };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/wallets', router);
  return { app };
}

function campaignRow(overrides = {}) {
  return {
    wallet_public_key: FAKE_WALLET_PUBLIC_KEY,
    creator_id: 'creator-1',
    ...overrides,
  };
}

// GET /:campaignId/config

test('GET /api/wallets/:campaignId/config returns multisig config for the owning creator', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [campaignRow()] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/config`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    thresholds: { med_threshold: 2 },
    signers: [{ key: 'GSIGNERFAKE', weight: 1 }],
  });
});

test('GET /api/wallets/:campaignId/config returns 404 for unknown campaign', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/config`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});

test('GET /api/wallets/:campaignId/config returns 403 for a non-owner', async () => {
  const { app } = buildApp({
    userId: 'someone-else',
    queryImpl: async () => ({ rows: [campaignRow()] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/config`);

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});

// GET /:campaignId/transactions

test('GET /api/wallets/:campaignId/transactions returns history using the default limit', async () => {
  let receivedLimit;
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [campaignRow()] }),
    stellarImpl: {
      getWalletTransactionHistory: async (publicKey, limit) => {
        receivedLimit = limit;
        assert.equal(publicKey, FAKE_WALLET_PUBLIC_KEY);
        return [{ hash: 'tx-1' }];
      },
    },
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/transactions`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ hash: 'tx-1' }]);
  assert.equal(receivedLimit, 50);
});

test('GET /api/wallets/:campaignId/transactions honors a custom ?limit=', async () => {
  let receivedLimit;
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [campaignRow()] }),
    stellarImpl: {
      getWalletTransactionHistory: async (_publicKey, limit) => {
        receivedLimit = limit;
        return [];
      },
    },
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/transactions?limit=5`);

  assert.equal(res.status, 200);
  assert.equal(receivedLimit, 5);
});

test('GET /api/wallets/:campaignId/transactions returns 404 for unknown campaign', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/transactions`);

  assert.equal(res.status, 404);
});

test('GET /api/wallets/:campaignId/transactions returns 403 for a non-owner', async () => {
  const { app } = buildApp({
    userId: 'someone-else',
    queryImpl: async () => ({ rows: [campaignRow()] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/transactions`);

  assert.equal(res.status, 403);
});

// GET /:campaignId/payments

test('GET /api/wallets/:campaignId/payments returns payment history using the default limit', async () => {
  let receivedLimit;
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [campaignRow()] }),
    stellarImpl: {
      getWalletPayments: async (publicKey, limit) => {
        receivedLimit = limit;
        assert.equal(publicKey, FAKE_WALLET_PUBLIC_KEY);
        return [{ id: 'pay-1' }];
      },
    },
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/payments`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 'pay-1' }]);
  assert.equal(receivedLimit, 100);
});

test('GET /api/wallets/:campaignId/payments honors a custom ?limit=', async () => {
  let receivedLimit;
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [campaignRow()] }),
    stellarImpl: {
      getWalletPayments: async (_publicKey, limit) => {
        receivedLimit = limit;
        return [];
      },
    },
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/payments?limit=7`);

  assert.equal(res.status, 200);
  assert.equal(receivedLimit, 7);
});

test('GET /api/wallets/:campaignId/payments returns 404 for unknown campaign', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/payments`);

  assert.equal(res.status, 404);
});

test('GET /api/wallets/:campaignId/payments returns 403 for a non-owner', async () => {
  const { app } = buildApp({
    userId: 'someone-else',
    queryImpl: async () => ({ rows: [campaignRow()] }),
  });

  const res = await request(app).get(`/api/wallets/${CAMPAIGN_ID}/payments`);

  assert.equal(res.status, 403);
});

// POST /:campaignId/recover

test('POST /api/wallets/:campaignId/recover decrypts the stored secret and returns the public key', async () => {
  let decryptedArg;
  let recoverArg;
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: FAKE_ENCRYPTED_SECRET, creator_id: 'creator-1' }],
    }),
    walletServiceImpl: {
      decryptSecret: (encrypted) => {
        decryptedArg = encrypted;
        return FAKE_DECRYPTED_SECRET;
      },
    },
    stellarImpl: {
      recoverWalletFromSecret: (secret) => {
        recoverArg = secret;
        return { publicKey: FAKE_WALLET_PUBLIC_KEY, secret };
      },
    },
  });

  const res = await request(app).post(`/api/wallets/${CAMPAIGN_ID}/recover`).send({});

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { publicKey: FAKE_WALLET_PUBLIC_KEY });
  assert.equal(decryptedArg, FAKE_ENCRYPTED_SECRET);
  assert.equal(recoverArg, FAKE_DECRYPTED_SECRET);
});

test('POST /api/wallets/:campaignId/recover returns 400 when no encrypted secret is stored', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: null, creator_id: 'creator-1' }],
    }),
  });

  const res = await request(app).post(`/api/wallets/${CAMPAIGN_ID}/recover`).send({});

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'No encrypted secret stored for this campaign' });
});

test('POST /api/wallets/:campaignId/recover returns 404 for unknown campaign', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).post(`/api/wallets/${CAMPAIGN_ID}/recover`).send({});

  assert.equal(res.status, 404);
});

test('POST /api/wallets/:campaignId/recover returns 403 for a non-owner', async () => {
  const { app } = buildApp({
    userId: 'someone-else',
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: FAKE_ENCRYPTED_SECRET, creator_id: 'creator-1' }],
    }),
  });

  const res = await request(app).post(`/api/wallets/${CAMPAIGN_ID}/recover`).send({});

  assert.equal(res.status, 403);
});
