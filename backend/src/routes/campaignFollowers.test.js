const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';

function buildApp(queryImpl) {
  const followService = proxyquire('../services/campaignFollowService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './notifications': { createNotification: async () => {} },
  });

  const router = proxyquire('./campaignFollowers', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'contributor' };
        next();
      },
    },
    '../services/campaignFollowService': followService,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

function followRow(overrides = {}) {
  return {
    campaign_id: CAMPAIGN_ID,
    notify_updates: true,
    notify_milestones: true,
    notify_funding: true,
    created_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

test('POST /:id/follow records the follow and returns the follower count', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: CAMPAIGN_ID }] };
    if (text.includes('INSERT INTO campaign_followers')) return { rows: [followRow()] };
    if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 3 }] };
    return { rows: [] };
  });

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/follow`).send({});

  assert.equal(res.status, 201);
  assert.equal(res.body.following, true);
  assert.equal(res.body.follower_count, 3);
  const insert = calls.find(call => call.text.includes('INSERT INTO campaign_followers'));
  assert.deepEqual(insert.params, ['user-1', CAMPAIGN_ID]);
});

test('POST /:id/follow stores the notification preferences it is given', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: CAMPAIGN_ID }] };
    if (text.includes('INSERT INTO campaign_followers')) {
      return { rows: [followRow({ notify_funding: false })] };
    }
    if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
    return { rows: [] };
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/follow`)
    .send({ notify_funding: false, unknown_field: 'ignored' });

  assert.equal(res.status, 201);
  assert.equal(res.body.notify_funding, false);
  const insert = calls.find(call => call.text.includes('INSERT INTO campaign_followers'));
  assert.deepEqual(insert.params, ['user-1', CAMPAIGN_ID, false]);
  assert.match(insert.text, /notify_funding = EXCLUDED\.notify_funding/);
  assert.doesNotMatch(insert.text, /notify_updates = EXCLUDED/);
});

test('POST /:id/follow 404s for an unknown campaign', async () => {
  const app = buildApp(async () => ({ rows: [] }));

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/follow`).send({});

  assert.equal(res.status, 404);
});

test('GET /:id/follow reports the default preferences when not following', async () => {
  const app = buildApp(async text => {
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: CAMPAIGN_ID }] };
    if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
    return { rows: [] };
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/follow`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    following: false,
    notify_updates: true,
    notify_milestones: true,
    notify_funding: true,
    follower_count: 0,
  });
});

test('PATCH /:id/follow updates only the preferences supplied', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: CAMPAIGN_ID }] };
    if (text.includes('UPDATE campaign_followers')) {
      return { rows: [followRow({ notify_updates: false })] };
    }
    return { rows: [] };
  });

  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/follow`)
    .send({ notify_updates: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.notify_updates, false);
  const update = calls.find(call => call.text.includes('UPDATE campaign_followers'));
  assert.deepEqual(update.params, ['user-1', CAMPAIGN_ID, false]);
});

test('PATCH /:id/follow rejects a body with no boolean preference', async () => {
  const app = buildApp(async text => {
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: CAMPAIGN_ID }] };
    return { rows: [] };
  });

  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/follow`)
    .send({ notify_updates: 'yes' });

  assert.equal(res.status, 422);
});

test('PATCH /:id/follow 404s when the user does not follow the campaign', async () => {
  const app = buildApp(async text => {
    if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: CAMPAIGN_ID }] };
    return { rows: [] };
  });

  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/follow`)
    .send({ notify_updates: false });

  assert.equal(res.status, 404);
});

test('DELETE /:id/follow removes the follow', async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    return { rows: [], rowCount: 1 };
  });

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/follow`);

  assert.equal(res.status, 204);
  const del = calls.find(call => call.text.includes('DELETE FROM campaign_followers'));
  assert.deepEqual(del.params, ['user-1', CAMPAIGN_ID]);
});
