const test = require('node:test');
const assert = require('node:assert/strict');
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
