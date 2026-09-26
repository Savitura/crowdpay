const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ deliveryRow = null, currentRow = null } = {}) {
  const queued = [];
  const router = proxyquire('./webhooks', {
    '../config/database': {
      query: async (sql) => {
        if (sql.includes('SELECT d.id, d.webhook_id')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT d.id AS delivery_id, d.status')) {
          return { rows: currentRow ? [currentRow] : [] };
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
    '../utils/ssrfGuard': {
      isSafeUrl: async () => ({ safe: true, reason: '' }),
    },
    '../services/webhookService': {
      processIncomingWebhook: async () => ({}),
      verifyWebhookSignature: () => true,
      WebhookError: class extends Error { constructor(m, s = 400) { super(m); this.status = s; } },
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

test('POST /api/webhooks/deliveries/:id/replay is idempotent while a replay is already queued or in flight (#838)', async () => {
  for (const status of ['pending', 'delivering']) {
    const { app, queued } = buildApp({ currentRow: { delivery_id: 'delivery-1', status } });
    const res = await request(app).post('/api/webhooks/deliveries/delivery-1/replay').expect(200);
    assert.equal(res.body.message, 'Replay already in progress');
    assert.deepEqual(queued, [], 'a repeated replay must not dispatch a second attempt');
  }
});

test('POST /api/webhooks/deliveries/:id/replay rejects an already delivered delivery with 409', async () => {
  const { app, queued } = buildApp({ currentRow: { delivery_id: 'delivery-1', status: 'delivered' } });
  await request(app).post('/api/webhooks/deliveries/delivery-1/replay').expect(409);
  assert.deepEqual(queued, []);
});

test('POST /api/webhooks/deliveries/:id/replay returns 404 for an unknown or foreign delivery', async () => {
  const { app, queued } = buildApp();
  await request(app).post('/api/webhooks/deliveries/delivery-1/replay').expect(404);
  assert.deepEqual(queued, []);
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
    '../utils/ssrfGuard': {
      isSafeUrl: async () => ({ safe: true, reason: '' }),
    },
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

// --- POST /api/webhooks/incoming/:id rate limiting (#489) -------------------
//
// The route's `incomingWebhookLimiter` is built with `skip: () => isTest`, so
// under the suite's normal `NODE_ENV=test` it never actually limits (matching
// the existing auth.js limiters' convention of being inert in tests). To
// exercise the real 30 req/min ceiling, this test loads a fresh, uncached copy
// of the module with NODE_ENV temporarily forced to a non-test value so the
// limiter's `max` is the real production value (30) instead of the
// effectively-infinite test value.
test('POST /incoming/:id returns 429 after 30 requests per minute from the same IP', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const modulePath = require.resolve('./webhooks');
  delete require.cache[modulePath];

  try {
    const router = proxyquire('./webhooks', {
      '../config/database': {
        query: async () => ({ rows: [{ id: WEBHOOK_ID, user_id: OWNER, secret: SECRET }] }),
      },
      '../middleware/auth': { requireAuth: (req, _res, next) => next() },
      '../services/webhookDispatcher': { ALL_WEBHOOK_EVENTS: [], processDelivery: async () => {} },
      '../utils/ssrfGuard': {
        isSafeUrl: async () => ({ safe: true, reason: '' }),
      },
      '../services/webhookService': proxyquire('../services/webhookService', {
        '../config/database': { query: async () => ({ rows: [] }) },
        '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
        './notifications': { createNotification: async () => {} },
      }),
    });

    const app = express();
    app.use('/api/webhooks', router);

    const body = JSON.stringify({ type: 'contribution.confirmed', tx_hash: 'tx-limit' });
    const sig = sign(SECRET, Buffer.from(body));

    for (let i = 0; i < 30; i += 1) {
      await request(app)
        .post(`/api/webhooks/incoming/${WEBHOOK_ID}`)
        .set('Content-Type', 'application/json')
        .set('x-signature-256', sig)
        .send(body);
    }

    const res = await request(app)
      .post(`/api/webhooks/incoming/${WEBHOOK_ID}`)
      .set('Content-Type', 'application/json')
      .set('x-signature-256', sig)
      .send(body);

    assert.equal(res.status, 429);
    assert.match(res.body.error, /Too many webhook deliveries/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    delete require.cache[modulePath];
  }
});

// --- POST /api/webhooks (create) SSRF URL validation ------------------------

function buildCreateApp({ safeUrlResult = { safe: true, reason: '' } } = {}) {
  const router = proxyquire('./webhooks', {
    '../config/database': {
      query: async () => ({
        rows: [{ id: 'wh-new', url: 'https://example.com/hook', events: ['campaign.funded'], backoff_strategy: null, created_at: new Date().toISOString() }],
      }),
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../services/webhookDispatcher': {
      ALL_WEBHOOK_EVENTS: ['campaign.funded'],
      isValidBackoffStrategy: () => true,
    },
    '../utils/ssrfGuard': {
      isSafeUrl: async () => safeUrlResult,
    },
    '../services/webhookService': {
      processIncomingWebhook: async () => ({}),
      verifyWebhookSignature: () => true,
      WebhookError: class extends Error { constructor(m, s = 400) { super(m); this.status = s; } },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', router);
  return { app };
}

test('POST / creates a webhook with a safe HTTPS URL', async () => {
  const { app } = buildCreateApp();
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'https://example.com/hook', events: ['campaign.funded'] })
    .expect(201);

  assert.ok(res.body.secret.startsWith('whsec_'));
});

test('POST / rejects webhook URL pointing to a private IP (10.x.x.x)', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal address: 10.0.0.1' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'http://10.0.0.1/admin', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL pointing to AWS cloud metadata (169.254.169.254)', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal address: 169.254.169.254' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'http://169.254.169.254/latest/meta-data/', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL pointing to localhost over non-HTTP protocol', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Only http: and https: protocols are allowed' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'ftp://localhost:21/data', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL pointing to Docker internal hostname', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal network: backend' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'http://backend:3001/internal', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL pointing to GCP metadata endpoint', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal address: metadata.google.internal' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'http://metadata.google.internal/', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL with DNS rebinding to private IP', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal network: evil.example.com' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'https://evil.example.com/hook', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL pointing to 127.0.0.1 (non-localhost loopback)', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal address: 127.0.0.1' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'http://127.0.0.1:8080/hook', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});

test('POST / rejects webhook URL with 192.168.x.x private range', async () => {
  const { app } = buildCreateApp({
    safeUrlResult: { safe: false, reason: 'Hostname resolves to a private/internal address: 192.168.1.1' },
  });
  const res = await request(app)
    .post('/api/webhooks')
    .send({ url: 'http://192.168.1.1:3000/hook', events: ['campaign.funded'] })
    .expect(400);

  assert.match(res.body.error, /https.*localhost/);
});
