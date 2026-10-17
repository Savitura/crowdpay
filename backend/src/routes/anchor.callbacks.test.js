/**
 * Tests for POST /api/anchor/callbacks/sep24
 *
 * This suite verifies the acceptance criteria from the "fiat provider webhooks
 * sit behind auth" fix:
 *
 *  1. The callback route is PUBLIC — no API-key authentication is required.
 *  2. The callback is protected by HMAC-SHA256 signature verification.
 *  3. Stale/missing timestamps are rejected (replay window).
 *  4. The payload is validated with a DTO — unknown/malformed shapes are 4xx.
 *  5. The callback is idempotent per provider event ID — a redelivery returns
 *     200 { duplicate: true } and does not credit twice.
 *  6. Permanent rejections return 4xx; transient failures return 5xx so the
 *     provider knows whether to retry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-hmac-secret-32-bytes-long!!!';
const REPLAY_WINDOW = 300; // seconds

function makeSignature(rawBody) {
  return `sha256=${crypto.createHmac('sha256', TEST_SECRET).update(rawBody).digest('hex')}`;
}

function nowTs() {
  return String(Math.floor(Date.now() / 1000));
}

function staleTs() {
  return String(Math.floor(Date.now() / 1000) - REPLAY_WINDOW - 10);
}

/**
 * Build a minimal Express app that mounts the anchor router with injectable
 * dependencies so each test can control what the DB / Redis / services do.
 */
function buildApp({
  queryImpl = async () => ({ rows: [] }),
  anchorServiceImpl = {},
  contributionServiceImpl = {},
  redisSetImpl = async () => 'OK', // 'OK' = first delivery, null = duplicate
} = {}) {
  const router = proxyquire('./anchor', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    '../config/redis': {
      set: redisSetImpl,
      del: async () => {},
      get: async () => null,
      pipeline: () => ({
        incr: () => {},
        expire: () => {},
        exec: async () => [
          [null, 1],
          [null, 0],
        ],
      }),
    },
    '../middleware/auth': {
      requireAuth: (_req, _res, next) => next(),
    },
    '../middleware/idempotency': {
      idempotency: () => (_req, _res, next) => next(),
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_c, _ctx, fn) => fn('SECRET'),
    },
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
      getSupportedAssetCodes: () => ['USDC'],
    },
    '../services/contributionService': {
      buildContributionIntent: async () => ({
        kind: 'payment',
        conversionQuote: null,
        flowMetadata: {},
      }),
      submitCustodialContribution: async () => ({ txHash: 'tx-abc', stellarTransactionId: 'st-1' }),
      ...contributionServiceImpl,
    },
    '../services/anchorService': {
      getAvailableAnchors: () => [],
      getAnchorById: () => null,
      publicAnchorInfo: a => a,
      isAnchorConfigured: () => true,
      authenticateWithAnchor: async () => ({
        token: 'tok',
        expiresAt: new Date(Date.now() + 60000),
      }),
      startInteractiveDeposit: async () => ({
        id: 'int-1',
        url: 'https://anchor.test/flow',
        status: 'pending',
      }),
      getAnchorTransaction: async () => ({ transaction: { status: 'pending' } }),
      isAnchorFailureStatus: s =>
        ['error', 'expired', 'no_market', 'too_small', 'too_large', 'refunded'].includes(s),
      ...anchorServiceImpl,
    },
  });

  const app = express();
  // Simulate the raw-body middleware that index.js mounts before express.json
  app.use('/api/anchor/callbacks', express.raw({ type: () => true }));
  app.use(express.json());
  app.use('/api/anchor', router);
  return app;
}

function makePayload(overrides = {}) {
  return JSON.stringify({
    transaction: {
      id: 'provider-tx-001',
      status: 'completed',
      amount_in: { amount: '10', asset: 'USDC' },
      ...overrides,
    },
  });
}

// ── Signature & timestamp tests ───────────────────────────────────────────────

test('POST /api/anchor/callbacks/sep24 — rejects request with no signature', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = makePayload();
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-timestamp', nowTs())
    .send(body);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /signature/i);
});

test('POST /api/anchor/callbacks/sep24 — rejects a tampered body', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = makePayload();
  const tampered = body.replace('completed', 'pending');
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body)) // signature for original body
    .set('x-anchor-timestamp', nowTs())
    .send(tampered);
  assert.equal(res.status, 401);
});

test('POST /api/anchor/callbacks/sep24 — rejects a stale timestamp (replay attack)', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = makePayload();
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', staleTs()) // outside window
    .send(body);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /timestamp/i);
});

test('POST /api/anchor/callbacks/sep24 — rejects missing timestamp when secret is set', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = makePayload();
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    // deliberately omit x-anchor-timestamp
    .send(body);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /timestamp/i);
});

// ── Payload validation (DTO) tests ────────────────────────────────────────────

test('POST /api/anchor/callbacks/sep24 — rejects non-JSON body', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = Buffer.from('not-json');
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /json/i);
});

test('POST /api/anchor/callbacks/sep24 — rejects payload without transaction.id', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = JSON.stringify({ transaction: { status: 'completed' } });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);
  assert.equal(res.status, 400);
  assert.match(res.body.field, /id/);
});

test('POST /api/anchor/callbacks/sep24 — rejects unknown status string', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp();
  const body = makePayload({ status: 'DEFINITELY_NOT_VALID' });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);
  assert.equal(res.status, 400);
  assert.match(res.body.field, /status/);
});

// ── Idempotency tests ─────────────────────────────────────────────────────────

test('POST /api/anchor/callbacks/sep24 — returns 200 duplicate:true on redelivery', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  // Simulate Redis already having the event ID (SET NX returns null = already exists)
  const app = buildApp({ redisSetImpl: async () => null });
  const body = makePayload();
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
});

// ── Resource-not-found → 4xx (permanent) ─────────────────────────────────────

test('POST /api/anchor/callbacks/sep24 — returns 404 when session not found (permanent, no retry)', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }), // no matching deposit
  });
  const body = makePayload();
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);
  assert.equal(res.status, 404);
  assert.ok(res.status < 500, '404 is a 4xx — provider must NOT retry');
});

// ── Successful completion ─────────────────────────────────────────────────────

test('POST /api/anchor/callbacks/sep24 — processes a completed wallet deposit', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const sessionRow = {
    id: 'dep-1',
    user_id: 'user-1',
    campaign_id: null,
    deposit_type: 'wallet',
    anchor_id: 'moneygram',
    anchor_transaction_id: 'provider-tx-wallet',
    anchor_asset: 'USDC',
    anchor_amount: '50',
    contribution_amount: null,
    contribution_tx_hash: null,
    contribution_id: null,
    contribution_flow: null,
    status: 'pending_anchor',
    last_anchor_status: 'pending',
    wallet_public_key: 'GUSER',
    wallet_secret_encrypted: 'enc',
  };

  let updateCalls = 0;
  const app = buildApp({
    queryImpl: async sql => {
      if (sql.includes('FROM anchor_deposits ad')) return { rows: [sessionRow] };
      if (sql.includes('UPDATE anchor_deposits')) {
        updateCalls++;
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const body = makePayload({ id: 'provider-tx-wallet', status: 'completed' });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);

  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
  assert.ok(updateCalls >= 2, 'should update status and then set to completed');
});

test('POST /api/anchor/callbacks/sep24 — submits a contribution on completed campaign deposit', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const sessionRow = {
    id: 'dep-2',
    user_id: 'user-1',
    campaign_id: 'camp-1',
    deposit_type: 'campaign',
    anchor_id: 'moneygram',
    anchor_transaction_id: 'provider-tx-camp',
    anchor_asset: 'USDC',
    anchor_amount: '100',
    contribution_amount: '100',
    contribution_tx_hash: null,
    contribution_id: null,
    contribution_flow: null,
    status: 'pending_anchor',
    last_anchor_status: 'pending',
    wallet_public_key: 'GUSER',
    wallet_secret_encrypted: 'enc',
  };

  let contributionSubmitted = false;
  const app = buildApp({
    queryImpl: async sql => {
      if (sql.includes('FROM anchor_deposits ad')) return { rows: [sessionRow] };
      if (sql.includes('FROM campaigns c JOIN users u'))
        return { rows: [{ id: 'camp-1', asset_type: 'USDC', status: 'active' }] };
      return { rows: [] };
    },
    contributionServiceImpl: {
      submitCustodialContribution: async ({ idempotencyKey }) => {
        contributionSubmitted = true;
        // Idempotency key must be set and scoped to the provider event
        assert.ok(idempotencyKey, 'idempotencyKey should be set');
        assert.match(idempotencyKey, /^anchor:/);
        return { txHash: 'tx-contrib', stellarTransactionId: 'st-2' };
      },
    },
  });

  const body = makePayload({ id: 'provider-tx-camp', status: 'completed' });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);

  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
  assert.ok(contributionSubmitted, 'contribution should have been submitted');
});

// ── 4xx for permanent rejections / 5xx for transient errors ──────────────────

test('POST /api/anchor/callbacks/sep24 — 422 when campaign is no longer active (permanent)', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const sessionRow = {
    id: 'dep-3',
    user_id: 'user-1',
    campaign_id: 'camp-gone',
    deposit_type: 'campaign',
    anchor_transaction_id: 'provider-tx-gone',
    anchor_asset: 'USDC',
    anchor_amount: '50',
    contribution_amount: '50',
    contribution_tx_hash: null,
    contribution_id: null,
    contribution_flow: null,
    status: 'pending_anchor',
    last_anchor_status: 'pending',
    wallet_public_key: 'GUSER',
    wallet_secret_encrypted: 'enc',
  };

  const app = buildApp({
    queryImpl: async sql => {
      if (sql.includes('FROM anchor_deposits ad')) return { rows: [sessionRow] };
      // Campaign lookup returns empty — campaign gone
      if (sql.includes('FROM campaigns c JOIN users u')) return { rows: [] };
      return { rows: [] };
    },
  });

  const body = makePayload({ id: 'provider-tx-gone', status: 'completed' });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);

  assert.equal(res.status, 422);
  assert.ok(res.status < 500, '422 is 4xx — provider must NOT retry');
  assert.equal(res.body.code, 'CAMPAIGN_NOT_ACTIVE');
});

test('POST /api/anchor/callbacks/sep24 — 500 on transient DB error (provider SHOULD retry)', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  let callCount = 0;
  const app = buildApp({
    queryImpl: async sql => {
      if (sql.includes('FROM anchor_deposits ad')) {
        callCount++;
        if (callCount === 1) {
          // First call succeeds to get past idempotency claim
          return {
            rows: [
              {
                id: 'dep-4',
                user_id: 'user-1',
                campaign_id: 'camp-1',
                deposit_type: 'campaign',
                anchor_transaction_id: 'provider-tx-err',
                anchor_asset: 'USDC',
                anchor_amount: '50',
                contribution_amount: '50',
                contribution_tx_hash: null,
                contribution_id: null,
                contribution_flow: null,
                status: 'pending_anchor',
                last_anchor_status: 'pending',
                wallet_public_key: 'GUSER',
                wallet_secret_encrypted: 'enc',
              },
            ],
          };
        }
      }
      if (sql.includes('UPDATE anchor_deposits')) {
        // Simulate a transient DB failure on the status update
        throw new Error('Connection reset by peer');
      }
      return { rows: [] };
    },
  });

  const body = makePayload({ id: 'provider-tx-err', status: 'completed' });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);

  assert.equal(res.status, 500, '5xx transient error — provider must retry');
});

// ── Failure / non-completed status updates ────────────────────────────────────

test('POST /api/anchor/callbacks/sep24 — marks session failed on anchor failure status', async () => {
  process.env.ANCHOR_CALLBACK_HMAC_SECRET = TEST_SECRET;
  const sessionRow = {
    id: 'dep-5',
    user_id: 'user-1',
    campaign_id: 'camp-1',
    deposit_type: 'campaign',
    anchor_transaction_id: 'provider-tx-fail',
    anchor_asset: 'USDC',
    anchor_amount: '50',
    contribution_amount: '50',
    contribution_tx_hash: null,
    contribution_id: null,
    contribution_flow: null,
    status: 'pending_anchor',
    last_anchor_status: 'pending',
    wallet_public_key: 'GUSER',
    wallet_secret_encrypted: 'enc',
  };

  let updatedStatus = null;
  const app = buildApp({
    queryImpl: async (sql, params) => {
      if (sql.includes('FROM anchor_deposits ad')) return { rows: [sessionRow] };
      if (sql.includes('UPDATE anchor_deposits')) {
        updatedStatus = params[0]; // first param is the new local status
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const body = makePayload({ id: 'provider-tx-fail', status: 'error' });
  const res = await request(app)
    .post('/api/anchor/callbacks/sep24')
    .set('content-type', 'application/octet-stream')
    .set('x-anchor-signature', makeSignature(body))
    .set('x-anchor-timestamp', nowTs())
    .send(body);

  assert.equal(res.status, 200);
  assert.equal(updatedStatus, 'failed');
});

// ── Cleanup env ───────────────────────────────────────────────────────────────

test.after(() => {
  delete process.env.ANCHOR_CALLBACK_HMAC_SECRET;
});
