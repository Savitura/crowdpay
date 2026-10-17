const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp(queryImpl) {
  const router = proxyquire('./users', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'contributor' };
        next();
      },
    },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
    },
    '../services/kycService': {
      startKycForUser: async () => ({ status: 'verified' }),
    },
    '../services/userDashboardService': {
      listCreatorCampaigns: async () => [],
      listUserContributions: async () => [],
    },
    '../services/stellarService': {
      getCampaignBalance: async () => '0',
    },
    '../services/analyticsService': {
      getUserDashboardAnalytics: async () => ({}),
    },
    './apiKeys': express.Router(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/users', router);
  return app;
}

test('GET /api/users/me/notification-preferences reflects notification_preferences state', async () => {
  const app = buildApp(async text => {
    if (text.includes('FROM notification_preferences')) {
      return {
        rows: [
          {
            campaign_updates: true,
            refunds: true,
            disputes: true,
            milestones: true,
            marketing: false,
          },
        ],
      };
    }
    return { rows: [] };
  });

  const res = await request(app).get('/api/users/me/notification-preferences');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    campaign_updates: true,
    refunds: true,
    disputes: true,
    milestones: true,
    marketing: false,
    category_digest: true,
  });
});

test('PATCH /api/users/me/notification-preferences stores preferences', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('FROM notification_preferences')) {
      return {
        rows: [
          {
            campaign_updates: true,
            refunds: true,
            disputes: true,
            milestones: true,
            marketing: true,
          },
        ],
      };
    }
    return { rows: [] };
  });

  const res = await request(app)
    .patch('/api/users/me/notification-preferences')
    .send({ campaign_updates: false, marketing: false });

  assert.equal(res.status, 200);

  const insert = calls.find(call => call.text.includes('INSERT INTO notification_preferences'));
  assert.ok(insert);

  assert.deepEqual(insert.params, ['user-1', false, null, null, null, false, null]);
});

test('PATCH /api/users/me/notification-preferences stores category_digest', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('INSERT INTO notification_preferences')) {
      return {
        rows: [
          {
            campaign_updates: true,
            refunds: true,
            disputes: true,
            milestones: true,
            marketing: false,
            category_digest: false,
          },
        ],
      };
    }
    return { rows: [] };
  });

  const res = await request(app)
    .patch('/api/users/me/notification-preferences')
    .send({ category_digest: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.category_digest, false);

  const insert = calls.find(call => call.text.includes('INSERT INTO notification_preferences'));
  assert.ok(insert.text.includes('category_digest'));
  assert.deepEqual(insert.params, ['user-1', null, null, null, null, null, false]);
});

test('recurring contribution amounts validate precision and persist as exact decimals', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: 'campaign-1' }] };
    if (text.includes('INSERT INTO recurring_contributions'))
      return { rows: [{ id: 'recurring-1' }] };
    return { rows: [] };
  });

  for (const amount of ['0.00000001', '1000000000000']) {
    const response = await request(app)
      .post('/api/users/me/recurring-contributions')
      .send({ campaign_id: 'campaign-1', amount, interval: 'monthly' });
    assert.equal(response.status, 400);
  }

  const created = await request(app)
    .post('/api/users/me/recurring-contributions')
    .send({ campaign_id: 'campaign-1', amount: '0.1', interval: 'monthly' });
  assert.equal(created.status, 201);
  const insert = calls.find(call => call.text.includes('INSERT INTO recurring_contributions'));
  assert.equal(insert.params[2], '0.1000000');

  const invalidUpdate = await request(app)
    .patch('/api/users/me/recurring-contributions/recurring-1')
    .send({ amount: '1e-9' });
  assert.equal(invalidUpdate.status, 400);
  assert.equal(
    calls.filter(call => call.text.includes('UPDATE recurring_contributions')).length,
    0
  );
});
