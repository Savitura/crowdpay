const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, authUser, authError, recordContributionImpl }) {
  const router = proxyquire('./v1', {
    '../config/database': { query: queryImpl },
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({}),
    },
    '../services/v1ContributionService': {
      recordContributionFromTxHash:
        recordContributionImpl ||
        (async () => ({
          id: 'contrib-1',
          campaign_id: 'camp-1',
          tx_hash: 'abc123',
          amount: 10,
        })),
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (authError) {
          return res.status(401).json({ error: authError });
        }
        req.user = authUser || { userId: 'user-1', role: 'creator' };
        req.auth = { kind: 'jwt' };
        next();
      },
    },
    '../middleware/validation': {
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

test('GET /api/v1/campaigns is public', async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ total: 1 }] };
      return {
        rows: [
          {
            id: 'camp-1',
            title: 'Test',
            target_amount: '100',
            raised_amount: '0',
            status: 'active',
          },
        ],
      };
    },
    authError: 'Missing token',
  });

  const res = await request(app).get('/api/v1/campaigns');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.campaigns.length, 1);
});

test('GET /api/v1/users/me returns 401 without auth', async () => {
  const app = buildApp({ authError: 'Missing token', queryImpl: async () => ({ rows: [] }) });
  const res = await request(app).get('/api/v1/users/me');
  assert.equal(res.status, 401);
});

test('GET /api/v1/users/me returns profile when authenticated', async () => {
  const app = buildApp({
    authUser: { userId: 'user-1' },
    queryImpl: async () => ({
      rows: [
        {
          id: 'user-1',
          email: 'dev@example.com',
          name: 'Dev',
          role: 'creator',
          campaigns_created: 2,
          contributions_made: 5,
        },
      ],
    }),
  });

  const res = await request(app)
    .get('/api/v1/users/me')
    .set('Authorization', 'Bearer cp_live_test');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'dev@example.com');
});

test('POST /api/v1/campaigns/:id/contributions records contribution from tx hash', async () => {
  let recorded;
  const app = buildApp({
    authUser: { userId: 'user-1' },
    queryImpl: async () => ({ rows: [] }),
    recordContributionImpl: async (args) => {
      recorded = args;
      return { id: 'c-1', tx_hash: args.txHash, amount: 25 };
    },
  });

  const res = await request(app)
    .post('/api/v1/campaigns/camp-1/contributions')
    .set('Authorization', 'Bearer cp_live_test')
    .send({ tx_hash: 'stellar-tx-hash' });

  assert.equal(res.status, 201);
  assert.equal(recorded.campaignId, 'camp-1');
  assert.equal(recorded.txHash, 'stellar-tx-hash');
});
