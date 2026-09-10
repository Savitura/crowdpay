const assert = require('node:assert');
const test = require('node:test');
const request = require('supertest');
const express = require('express');
const proxyquire = require('proxyquire').noCallThru();

const mockDb = {
  query: async (sql, params) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '2' }] };
    if (sql.includes('INSERT INTO creator_refunds')) {
      return {
        rows: [{
          id: 'refund-1',
          campaign_id: params[0],
          contribution_id: params[1],
          recipient_wallet: params[2],
          amount: params[3],
          asset: params[4],
          reason: params[5],
          status: 'pending',
          created_by: params[6],
        }],
      };
    }
    if (sql.includes('UPDATE creator_refunds')) {
      return {
        rows: [{
          id: params[params.length - 1],
          status: params[0],
          processed_at: new Date().toISOString(),
        }],
      };
    }
    return {
      rows: [
        { id: 'r1', campaign_id: 'c1', amount: '100.00', status: 'pending', created_at: new Date().toISOString() },
        { id: 'r2', campaign_id: 'c1', amount: '50.00', status: 'completed', created_at: new Date().toISOString() },
      ],
    };
  },
};

function createApp(user) {
  const router = proxyquire('./creatorRefunds', {
    '../config/database': mockDb,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user;
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin/refunds', router);
  return app;
}

test('GET /api/admin/refunds returns paginated refunds', async () => {
  const app = createApp({ userId: 'admin1', role: 'admin' });
  const res = await request(app).get('/api/admin/refunds');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.total, 2);
});

test('POST /api/admin/refunds creates a refund', async () => {
  const app = createApp({ userId: 'admin1', role: 'admin' });
  const res = await request(app)
    .post('/api/admin/refunds')
    .send({ campaignId: 'c1', recipientWallet: 'GABC', amount: 100, asset: 'native', reason: 'Goodwill' });
  assert.equal(res.status, 201);
  assert.equal(res.body.amount, '100');
  assert.equal(res.body.status, 'pending');
});

test('PATCH /api/admin/refunds/:id updates status', async () => {
  const app = createApp({ userId: 'admin1', role: 'admin' });
  const res = await request(app)
    .patch('/api/admin/refunds/r1')
    .send({ status: 'completed', stellarTxHash: 'txhash123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
});
