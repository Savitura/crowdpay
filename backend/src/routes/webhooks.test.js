const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ deliveryRow = null } = {}) {
  const queued = [];
  const router = proxyquire('./webhooks', {
    '../config/database': {
      query: async (sql) => {
        if (sql.includes('SELECT d.id, d.webhook_id')) {
          return { rows: [] };
        }
        if (sql.includes('UPDATE webhook_deliveries')) {
          return { rows: deliveryRow ? [deliveryRow] : [] };
        }
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../services/webhookDispatcher': {
      ALL_WEBHOOK_EVENTS: ['campaign.funded'],
      processDelivery: async (deliveryId) => {
        queued.push(deliveryId);
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', router);
  return { app, queued };
}

test('POST /api/webhooks/deliveries/:id/replay requeues a failed delivery for the current user', async () => {
  const { app, queued } = buildApp({ deliveryRow: { id: 'delivery-1' } });

  const res = await request(app)
    .post('/api/webhooks/deliveries/delivery-1/replay')
    .expect(200);

  assert.equal(res.body.message, 'Replay queued');
  assert.deepEqual(queued, ['delivery-1']);
});

// --- POST /api/webhooks/incoming/:id (signature + dispatch) ------------------

const WEBHOOK_ID = 'wh-1';
const OWNER = 'owner-1';
const SECRET = 'whsec_test';

// Wire the incoming route to the REAL webhookService (so signature verification
// and type routing are exercised end-to-end), backed by a scripted db. The
// webhook-secret lookup returns `webhookRow`; every other query is resolved by
// `serviceQuery` so handlers can be steered per test.
function buildIncomingApp({
  webhookRow = { id: WEBHOOK_ID, user_id: OWNER, secret: SECRET },
  serviceQuery = async () => ({ rows: [] }),
} = {}) {
  const router = proxyquire('./webhooks', {
    '../config/database': {
      query: async (sql, params) => {
        if (sql.includes('FROM webhooks WHERE id = $1 AND revoked_at IS NULL')) {
          return { rows: webhookRow ? [webhookRow] : [] };
        }
        return serviceQuery(sql, params);
      },
    },
    '../middleware/auth': { requireAuth: (req, _res, next) => next() },
    '../services/webhookDispatcher': { ALL_WEBHOOK_EVENTS: [], processDelivery: async () => {} },
    '../services/webhookService': proxyquire('../services/webhookService', {
      '../config/database': { query: async (sql, params) => serviceQuery(sql, params) },
      '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
      './notifications': { createNotification: async () => {} },
    }),
  });

  const app = express();
  app.use('/api/webhooks', router);
  return { app };
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function post(app, body, sig) {
  const req = request(app)
    .post(`/api/webhooks/incoming/${WEBHOOK_ID}`)
    .set('Content-Type', 'application/json');
  if (sig !== null) req.set('x-signature-256', sig);
  return req.send(body);
}

test('POST /incoming/:id returns 404 when the webhook is unknown', async () => {
  const { app } = buildIncomingApp({ webhookRow: null });
  await post(app, '{}', 'whatever').expect(404);
});

test('POST /incoming/:id returns 401 when the signature header is missing', async () => {
  const { app } = buildIncomingApp();
  await post(app, '{}', null).expect(401);
});

test('POST /incoming/:id returns 401 on an invalid signature', async () => {
  const { app } = buildIncomingApp();
  const body = JSON.stringify({ type: 'contribution.confirmed', tx_hash: 't' });
  await post(app, body, 'deadbeef').expect(401);
});

test('POST /incoming/:id returns 400 on malformed JSON with a valid signature', async () => {
  const { app } = buildIncomingApp();
  const body = 'not-json';
  await post(app, body, sign(SECRET, Buffer.from(body))).expect(400);
});

test('POST /incoming/:id returns 400 for an unknown event type', async () => {
  const { app } = buildIncomingApp();
  const body = JSON.stringify({ type: 'totally.unknown' });
  const res = await post(app, body, sign(SECRET, Buffer.from(body))).expect(400);
  assert.match(res.body.error, /Unsupported/);
});

test('POST /incoming/:id acknowledges a valid contribution.confirmed for an un-indexed tx', async () => {
  // No matching contribution → handler returns 202, wrapped in a 200 envelope.
  const { app } = buildIncomingApp({ serviceQuery: async () => ({ rows: [] }) });
  const body = JSON.stringify({ type: 'contribution.confirmed', tx_hash: 'tx-unknown' });
  const res = await post(app, body, sign(SECRET, Buffer.from(body))).expect(200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 202);
  assert.equal(res.body.body.linked, false);
});

test('POST /incoming/:id links a matching contribution and returns success', async () => {
  const { app } = buildIncomingApp({
    serviceQuery: async (sql) => {
      if (sql.includes('FROM contributions')) {
        return { rows: [{ id: 'c-1', campaign_id: 'cam-1', amount: '10', asset: 'USDC', title: 'T' }] };
      }
      return { rows: [] };
    },
  });
  const body = JSON.stringify({ type: 'contribution.confirmed', tx_hash: 'tx-1' });
  const res = await post(app, body, sign(SECRET, Buffer.from(body))).expect(200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 200);
  assert.equal(res.body.body.linked, true);
  assert.equal(res.body.body.contribution_id, 'c-1');
});
