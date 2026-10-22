const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildWebhookApp({
  userId = 'creator-1',
  webhookRows = [
    {
      id: 'wh-1',
      url: 'https://example.com/hook',
      events: ['contribution.received', 'campaign.funded'],
      secret: 'whsec_test',
      user_id: 'creator-1',
    },
  ],
  deliveryRows = [],
  deliveryDetail = null,
  attemptRows = [],
  countTotal = 0,
  onProcessDelivery = async () => {},
} = {}) {
  const queryLog = [];

  const router = proxyquire('./webhooks', {
    '../config/database': {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        // Webhook lookup by id and user_id
        if (
          sql.includes(
            'SELECT id, url, events, secret, user_id FROM webhooks WHERE id = $1 AND user_id = $2'
          )
        ) {
          const match = webhookRows.find(w => w.id === params[0] && w.user_id === params[1]);
          return { rows: match ? [match] : [] };
        }

        // Webhook ownership check for /:id/deliveries
        if (
          sql.includes(
            'SELECT id, url, events, revoked_at FROM webhooks WHERE id = $1 AND user_id = $2'
          )
        ) {
          const match = webhookRows.find(w => w.id === params[0] && w.user_id === params[1]);
          return { rows: match ? [match] : [] };
        }

        // Insert delivery
        if (sql.includes('INSERT INTO webhook_deliveries')) {
          const newDelivery = {
            id: 'del-new-1',
            webhook_id: params[0],
            event_type: params[1],
            payload: JSON.parse(params[2]),
            status: 'pending',
            created_at: new Date().toISOString(),
          };
          return { rows: [newDelivery] };
        }

        // Single delivery lookup after dispatch
        if (
          sql.includes('FROM webhook_deliveries d') &&
          sql.includes('WHERE d.id = $1') &&
          !sql.includes('w.user_id')
        ) {
          return {
            rows: deliveryDetail
              ? [deliveryDetail]
              : [
                  {
                    id: params[0],
                    webhook_id: 'wh-1',
                    event_type: 'contribution.received',
                    status: 'delivered',
                    response_status: 200,
                    attempt_count: 1,
                    created_at: new Date().toISOString(),
                  },
                ],
          };
        }

        // Single delivery lookup with user ownership
        if (
          sql.includes('FROM webhook_deliveries d') &&
          sql.includes('WHERE d.id = $1 AND w.user_id = $2')
        ) {
          return { rows: deliveryDetail ? [deliveryDetail] : [] };
        }

        // Attempts history
        if (sql.includes('FROM webhook_delivery_attempts')) {
          return { rows: attemptRows };
        }

        // Count queries
        if (sql.includes('SELECT COUNT(*)::int AS total')) {
          return { rows: [{ total: countTotal }] };
        }

        // List deliveries
        if (
          sql.includes('FROM webhook_deliveries d') &&
          sql.includes('ORDER BY d.created_at DESC')
        ) {
          return { rows: deliveryRows };
        }

        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    },
    '../services/webhookDispatcher': {
      ALL_WEBHOOK_EVENTS: [
        'campaign.funded',
        'campaign.failed',
        'contribution.received',
        'contribution.indexed',
        'contribution.refunded',
        'milestone.approved',
        'milestone.rejected',
        'withdrawal.completed',
        'withdrawal.updated',
        'dispute.opened',
        'dispute.resolved',
        'sponsor_match.created',
        'sponsor_match.completed',
      ],
      processDelivery: async deliveryId => {
        await onProcessDelivery(deliveryId);
      },
      isValidBackoffStrategy: () => true,
    },
    '../utils/ssrfGuard': {
      isSafeUrl: async () => ({ safe: true, reason: '' }),
    },
    '../services/auditService': {
      logCredentialEvent: async () => {},
    },
    '../services/webhookService': {
      processIncomingWebhook: async () => ({}),
      verifyWebhookSignature: () => true,
      WebhookError: class extends Error {},
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', router);
  return { app, queryLog };
}

// ---------------------------------------------------------------------------
// 1. POST /api/webhooks/:id/test (Primary Path, Failure Path, Auth, Edge Cases)
// ---------------------------------------------------------------------------

test('POST /api/webhooks/:id/test dispatches test event, logs delivery and returns success with latency', async () => {
  let processedDeliveryId = null;
  const { app, queryLog } = buildWebhookApp({
    deliveryDetail: {
      id: 'del-new-1',
      webhook_id: 'wh-1',
      event_type: 'contribution.received',
      status: 'delivered',
      response_status: 200,
      response_body_snippet: '{"ok":true}',
      attempt_count: 1,
      last_error: null,
      delivered_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: { test: true, event: 'contribution.received', amount: '150.00' },
      webhook_url: 'https://example.com/hook',
    },
    onProcessDelivery: async id => {
      processedDeliveryId = id;
    },
  });

  const res = await request(app)
    .post('/api/webhooks/wh-1/test')
    .send({ event_type: 'contribution.received' })
    .expect(200);

  assert.equal(res.body.success, true);
  assert.equal(res.body.delivery.id, 'del-new-1');
  assert.equal(res.body.delivery.status, 'delivered');
  assert.equal(res.body.delivery.response_status, 200);
  assert.ok(typeof res.body.latency_ms === 'number' && res.body.latency_ms >= 0);
  assert.equal(processedDeliveryId, 'del-new-1');

  // Verify that an insert into webhook_deliveries occurred with payload containing test: true
  const insertQuery = queryLog.find(q => q.sql.includes('INSERT INTO webhook_deliveries'));
  assert.ok(insertQuery);
  const payload = JSON.parse(insertQuery.params[2]);
  assert.equal(payload.test, true);
  assert.equal(payload.event, 'contribution.received');
});

test('POST /api/webhooks/:id/test defaults to webhook configured events when event_type is omitted', async () => {
  const { app, queryLog } = buildWebhookApp({
    webhookRows: [
      {
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['campaign.funded'],
        secret: 'whsec_test',
        user_id: 'creator-1',
      },
    ],
  });

  const res = await request(app).post('/api/webhooks/wh-1/test').send({}).expect(200);

  assert.equal(res.body.success, true);
  const insertQuery = queryLog.find(q => q.sql.includes('INSERT INTO webhook_deliveries'));
  assert.ok(insertQuery);
  assert.equal(insertQuery.params[1], 'campaign.funded');
});

test('POST /api/webhooks/:id/test records non-2xx failure status and error details', async () => {
  const { app } = buildWebhookApp({
    deliveryDetail: {
      id: 'del-new-1',
      webhook_id: 'wh-1',
      event_type: 'contribution.received',
      status: 'failed',
      response_status: 500,
      response_body_snippet: 'Internal Server Error',
      attempt_count: 1,
      last_error: 'HTTP 500',
      delivered_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: { test: true },
      webhook_url: 'https://example.com/hook',
    },
  });

  const res = await request(app)
    .post('/api/webhooks/wh-1/test')
    .send({ event_type: 'contribution.received' })
    .expect(200);

  assert.equal(res.body.success, false);
  assert.equal(res.body.delivery.status, 'failed');
  assert.equal(res.body.delivery.response_status, 500);
  assert.equal(res.body.delivery.last_error, 'HTTP 500');
  assert.match(res.body.message, /HTTP 500/);
});

test('POST /api/webhooks/:id/test handles endpoint timeout or connection failure gracefully', async () => {
  const { app } = buildWebhookApp({
    deliveryDetail: {
      id: 'del-new-1',
      webhook_id: 'wh-1',
      event_type: 'contribution.received',
      status: 'failed',
      response_status: null,
      response_body_snippet: null,
      attempt_count: 1,
      last_error: 'Request timeout after 9000ms',
      delivered_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: { test: true },
      webhook_url: 'https://example.com/hook',
    },
  });

  const res = await request(app)
    .post('/api/webhooks/wh-1/test')
    .send({ event_type: 'contribution.received' })
    .expect(200);

  assert.equal(res.body.success, false);
  assert.equal(res.body.delivery.status, 'failed');
  assert.match(res.body.delivery.last_error, /timeout/i);
});

test('POST /api/webhooks/:id/test returns 404 for non-existent or foreign webhook', async () => {
  const { app } = buildWebhookApp({
    userId: 'other-user',
    webhookRows: [
      {
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['contribution.received'],
        secret: 'whsec_test',
        user_id: 'creator-1',
      },
    ],
  });

  const res = await request(app)
    .post('/api/webhooks/wh-1/test')
    .send({ event_type: 'contribution.received' })
    .expect(404);

  assert.equal(res.body.error, 'Webhook not found');
});

test('POST /api/webhooks/:id/test rejects an unsupported event type with 400', async () => {
  const { app } = buildWebhookApp();

  const res = await request(app)
    .post('/api/webhooks/wh-1/test')
    .send({ event_type: 'unsupported.malicious.event' })
    .expect(400);

  assert.match(res.body.error, /event_type must be one of/);
});

// ---------------------------------------------------------------------------
// 2. GET /api/webhooks/deliveries (Pagination, Filtering, Backward Compatibility)
// ---------------------------------------------------------------------------

test('GET /api/webhooks/deliveries returns paginated envelope when paginate=true or page is passed', async () => {
  const mockDeliveries = [
    {
      id: 'del-1',
      webhook_id: 'wh-1',
      event_type: 'contribution.received',
      status: 'delivered',
      response_status: 200,
      attempt_count: 1,
      latency_ms: 60,
      created_at: new Date().toISOString(),
    },
  ];

  const { app, queryLog } = buildWebhookApp({
    countTotal: 42,
    deliveryRows: mockDeliveries,
  });

  const res = await request(app).get('/api/webhooks/deliveries?page=2&limit=10').expect(200);

  assert.equal(res.body.total, 42);
  assert.equal(res.body.page, 2);
  assert.equal(res.body.limit, 10);
  assert.equal(res.body.offset, 10);
  assert.equal(res.body.total_pages, 5);
  assert.equal(res.body.deliveries.length, 1);
  assert.equal(res.headers['x-total-count'], '42');
  assert.equal(res.headers['x-page'], '2');

  const dataQuery = queryLog.find(q => q.sql.includes('LIMIT') && q.sql.includes('OFFSET'));
  assert.ok(dataQuery);
  assert.equal(dataQuery.params[dataQuery.params.length - 2], 10); // limit
  assert.equal(dataQuery.params[dataQuery.params.length - 1], 10); // offset
});

test('GET /api/webhooks/deliveries filters by status and event_type', async () => {
  const { app, queryLog } = buildWebhookApp({
    countTotal: 5,
    deliveryRows: [],
  });

  await request(app)
    .get(
      '/api/webhooks/deliveries?status=failed&event_type=contribution.received&webhook_id=wh-1&paginate=true'
    )
    .expect(200);

  const countQuery = queryLog.find(q => q.sql.includes('SELECT COUNT(*)'));
  assert.ok(countQuery);
  assert.ok(countQuery.sql.includes('d.status = $'));
  assert.ok(countQuery.sql.includes('d.event_type = $'));
  assert.ok(countQuery.sql.includes('w.id = $'));
  assert.ok(countQuery.params.includes('failed'));
  assert.ok(countQuery.params.includes('contribution.received'));
  assert.ok(countQuery.params.includes('wh-1'));
});

test('GET /api/webhooks/deliveries preserves backward compatibility (returns array) when pagination params are absent', async () => {
  const mockDeliveries = [
    {
      id: 'del-1',
      webhook_id: 'wh-1',
      event_type: 'contribution.received',
      status: 'delivered',
      created_at: new Date().toISOString(),
    },
  ];

  const { app } = buildWebhookApp({
    countTotal: 1,
    deliveryRows: mockDeliveries,
  });

  const res = await request(app).get('/api/webhooks/deliveries').expect(200);

  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 1);
  assert.equal(res.headers['x-total-count'], '1');
});

// ---------------------------------------------------------------------------
// 3. GET /api/webhooks/:id/deliveries (Scoped Per-Webhook Delivery History)
// ---------------------------------------------------------------------------

test('GET /api/webhooks/:id/deliveries returns scoped delivery logs with pagination', async () => {
  const mockDeliveries = [
    {
      id: 'del-1',
      webhook_id: 'wh-1',
      event_type: 'campaign.funded',
      status: 'delivered',
      response_status: 200,
      latency_ms: 75,
      created_at: new Date().toISOString(),
    },
  ];

  const { app } = buildWebhookApp({
    countTotal: 1,
    deliveryRows: mockDeliveries,
  });

  const res = await request(app).get('/api/webhooks/wh-1/deliveries?limit=20').expect(200);

  assert.equal(res.body.webhook_id, 'wh-1');
  assert.equal(res.body.total, 1);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.deliveries.length, 1);
});

test('GET /api/webhooks/:id/deliveries returns 404 for a foreign or non-existent webhook', async () => {
  const { app } = buildWebhookApp({
    userId: 'attacker-user',
    webhookRows: [{ id: 'wh-1', url: 'https://example.com/hook', user_id: 'creator-1' }],
  });

  await request(app).get('/api/webhooks/wh-1/deliveries').expect(404);
});

// ---------------------------------------------------------------------------
// 4. GET /api/webhooks/deliveries/:id (Delivery Detail View with Attempts)
// ---------------------------------------------------------------------------

test('GET /api/webhooks/deliveries/:id returns full payload and attempt history', async () => {
  const { app } = buildWebhookApp({
    deliveryDetail: {
      id: 'del-1',
      webhook_id: 'wh-1',
      event_type: 'contribution.received',
      status: 'delivered',
      response_status: 200,
      response_body_snippet: '{"received":true}',
      attempt_count: 2,
      last_error: null,
      delivered_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      payload: { test: true, donor: 'G_TEST' },
      webhook_url: 'https://example.com/hook',
    },
    attemptRows: [
      {
        attempt_number: 1,
        response_status: 504,
        succeeded: false,
        error_message: 'Gateway Timeout',
        latency_ms: 9000,
      },
      {
        attempt_number: 2,
        response_status: 200,
        succeeded: true,
        error_message: null,
        latency_ms: 110,
      },
    ],
  });

  const res = await request(app).get('/api/webhooks/deliveries/del-1').expect(200);

  assert.equal(res.body.id, 'del-1');
  assert.deepEqual(res.body.payload, { test: true, donor: 'G_TEST' });
  assert.equal(res.body.attempts.length, 2);
  assert.equal(res.body.attempts[0].attempt_number, 1);
  assert.equal(res.body.attempts[1].succeeded, true);
});

test('GET /api/webhooks/deliveries/:id returns 404 for non-existent delivery or foreign delivery', async () => {
  const { app } = buildWebhookApp({ deliveryDetail: null });
  await request(app).get('/api/webhooks/deliveries/del-unknown').expect(404);
});
