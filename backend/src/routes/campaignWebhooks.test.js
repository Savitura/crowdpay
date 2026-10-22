const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildCampaignWebhookApp({
  userId = 'creator-1',
  role = 'creator',
  campaignCreatorId = 'creator-1',
  webhookRows = [],
  deliveryRows = [],
  deliveryDetail = null,
  countWebhooks = 0,
  countDeliveries = 0,
  onProcessDelivery = async () => {},
} = {}) {
  const queryLog = [];

  const router = proxyquire('./campaignWebhooks', {
    '../config/database': {
      query: async (sql, params = []) => {
        queryLog.push({ sql, params });

        // Campaign lookup
        if (sql.includes('SELECT id, creator_id FROM campaigns WHERE id = $1')) {
          if (params[0] === 'camp-1') {
            return { rows: [{ id: 'camp-1', creator_id: campaignCreatorId }] };
          }
          return { rows: [] };
        }

        // Webhook count check
        if (sql.includes('SELECT COUNT(*)::int as count FROM campaign_webhooks')) {
          return { rows: [{ count: countWebhooks }] };
        }

        // Insert campaign webhook
        if (sql.includes('INSERT INTO campaign_webhooks')) {
          return {
            rows: [
              {
                id: 'wh-camp-1',
                campaign_id: params[0],
                url: params[1],
                events: params[3],
                active: true,
                created_at: new Date().toISOString(),
              },
            ],
          };
        }

        // List campaign webhooks
        if (
          sql.includes('FROM campaign_webhooks') &&
          sql.includes('WHERE campaign_id = $1') &&
          !sql.includes('COUNT')
        ) {
          return { rows: webhookRows };
        }

        // Single campaign webhook lookup
        if (sql.includes('FROM campaign_webhooks') && sql.includes('WHERE id = $1')) {
          const match = webhookRows.find(w => w.id === params[0]);
          return { rows: match ? [match] : [] };
        }

        // Delete/deactivate campaign webhook
        if (sql.includes('UPDATE campaign_webhooks SET active = FALSE')) {
          return { rows: [{ id: params[0] }] };
        }

        // Insert campaign delivery
        if (sql.includes('INSERT INTO campaign_webhook_deliveries')) {
          return {
            rows: [
              {
                id: 'camp-del-1',
                webhook_id: params[0],
                event: params[1],
                payload: JSON.parse(params[2]),
                status: 'pending',
                created_at: new Date().toISOString(),
              },
            ],
          };
        }

        // Delivery lookup after dispatch
        if (sql.includes('FROM campaign_webhook_deliveries d') && sql.includes('WHERE d.id = $1')) {
          return {
            rows: deliveryDetail
              ? [deliveryDetail]
              : [
                  {
                    id: params[0],
                    webhook_id: 'wh-camp-1',
                    event: 'contribution.indexed',
                    status: 'delivered',
                    response_status: 200,
                    attempt_count: 1,
                    last_error: null,
                    delivered_at: new Date().toISOString(),
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    payload: { test: true },
                    webhook_url: 'https://example.com/hook',
                  },
                ],
          };
        }

        // Delivery count
        if (sql.includes('SELECT COUNT(*)::int as total FROM campaign_webhook_deliveries')) {
          return { rows: [{ total: countDeliveries }] };
        }

        // Delivery list
        if (
          sql.includes('FROM campaign_webhook_deliveries d') &&
          sql.includes('ORDER BY d.created_at DESC')
        ) {
          return { rows: deliveryRows };
        }

        // Replay delivery
        if (
          sql.includes('UPDATE campaign_webhook_deliveries d') &&
          sql.includes("SET status = 'pending'")
        ) {
          return { rows: [{ id: params[0] }] };
        }

        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId, role };
        next();
      },
    },
    '../services/webhookDispatcher': {
      processCampaignWebhookDelivery: async deliveryId => {
        await onProcessDelivery(deliveryId);
      },
      isValidBackoffStrategy: () => true,
    },
    '../utils/ssrfGuard': {
      isSafeUrl: async url => {
        if (url.includes('private.internal') || url.includes('169.254')) {
          return { safe: false, reason: 'SSRF blocked' };
        }
        return { safe: true, reason: '' };
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return { app, queryLog };
}

test('POST /api/campaigns/:id/webhooks registers a campaign webhook for the creator', async () => {
  const { app } = buildCampaignWebhookApp();

  const res = await request(app)
    .post('/api/campaigns/camp-1/webhooks')
    .send({ url: 'https://example.com/campaign-hook', events: ['contribution.indexed'] })
    .expect(201);

  assert.equal(res.body.id, 'wh-camp-1');
  assert.equal(res.body.campaign_id, 'camp-1');
  assert.ok(res.body.secret);
  assert.ok(res.body.secret_hint);
});

test('POST /api/campaigns/:id/webhooks rejects unsafe/SSRF URLs', async () => {
  const { app } = buildCampaignWebhookApp();

  const res = await request(app)
    .post('/api/campaigns/camp-1/webhooks')
    .send({ url: 'http://private.internal/webhook' })
    .expect(400);

  assert.match(res.body.error, /https, or http:\/\/localhost/);
});

test('POST /api/campaigns/:id/webhooks enforces the limit of 5 webhooks per campaign', async () => {
  const { app } = buildCampaignWebhookApp({ countWebhooks: 5 });

  const res = await request(app)
    .post('/api/campaigns/camp-1/webhooks')
    .send({ url: 'https://example.com/hook' })
    .expect(429);

  assert.match(res.body.error, /limited to 5/);
});

test('POST /api/campaigns/:id/webhooks/:wid/test dispatches a test event and returns delivery log', async () => {
  let executedDeliveryId = null;
  const { app } = buildCampaignWebhookApp({
    webhookRows: [
      {
        id: 'wh-camp-1',
        campaign_id: 'camp-1',
        url: 'https://example.com/hook',
        events: ['contribution.indexed'],
        active: true,
      },
    ],
    onProcessDelivery: async id => {
      executedDeliveryId = id;
    },
  });

  const res = await request(app)
    .post('/api/campaigns/camp-1/webhooks/wh-camp-1/test')
    .send({})
    .expect(200);

  assert.equal(res.body.success, true);
  assert.equal(res.body.delivery.status, 'delivered');
  assert.equal(res.body.delivery.response_status, 200);
  assert.equal(executedDeliveryId, 'camp-del-1');
});

test('GET /api/campaigns/:id/webhooks/:wid/deliveries returns paginated delivery history', async () => {
  const { app } = buildCampaignWebhookApp({
    webhookRows: [{ id: 'wh-camp-1', campaign_id: 'camp-1', url: 'https://example.com/hook' }],
    countDeliveries: 15,
    deliveryRows: [
      {
        id: 'del-1',
        webhook_id: 'wh-camp-1',
        event: 'contribution.indexed',
        status: 'delivered',
        response_status: 200,
        attempt_count: 1,
        latency_ms: 85,
        created_at: new Date().toISOString(),
      },
    ],
  });

  const res = await request(app)
    .get('/api/campaigns/camp-1/webhooks/wh-camp-1/deliveries?page=2&limit=5')
    .expect(200);

  assert.equal(res.body.total, 15);
  assert.equal(res.body.page, 2);
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.offset, 5);
  assert.equal(res.body.total_pages, 3);
  assert.equal(res.body.deliveries.length, 1);
});

test('campaign webhook endpoints reject non-creators with 403', async () => {
  const { app } = buildCampaignWebhookApp({
    userId: 'unauthorized-user',
    campaignCreatorId: 'creator-1',
  });

  await request(app).get('/api/campaigns/camp-1/webhooks').expect(403);
  await request(app)
    .post('/api/campaigns/camp-1/webhooks')
    .send({ url: 'https://example.com' })
    .expect(403);
  await request(app).post('/api/campaigns/camp-1/webhooks/wh-1/test').send({}).expect(403);
});
