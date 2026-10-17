const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ creatorId = 'creator-1', activity = [] } = {}) {
  const queries = [];
  const router = proxyquire('./campaignActivity', {
    '../config/database': {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT creator_id')) return { rows: [{ creator_id: creatorId }] };
        return { rows: activity };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'creator-1', role: 'creator' };
        next();
      },
    },
  });
  const app = express();
  app.use('/api/campaigns', router);
  return { app, queries };
}

test('campaign activity is limited to the campaign creator', async () => {
  const { app, queries } = buildApp({ creatorId: 'another-user' });
  const res = await request(app).get('/api/campaigns/camp-1/activity');

  assert.equal(res.status, 403);
  assert.equal(queries.length, 1);
});

test('campaign activity returns paginated events without contributor identity', async () => {
  const activity = [
    {
      event_type: 'contribution',
      event_id: 'event-1',
      occurred_at: '2026-09-29T12:00:00.000Z',
      summary: 'Contribution received',
      details: { amount: '10', asset: 'USDC' },
    },
  ];
  const { app, queries } = buildApp({ activity });
  const res = await request(app).get('/api/campaigns/camp-1/activity?limit=10&offset=20');

  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].details.amount, '10');
  assert.equal(res.body.data[0].sender_public_key, undefined);
  assert.deepEqual(queries[1].params, ['camp-1', 10, 20]);
  assert.doesNotMatch(queries[1].sql, /sender_public_key|display_name/);
});

test('campaign activity exports CSV', async () => {
  const activity = [
    {
      event_type: 'update',
      event_id: 'event-1',
      occurred_at: '2026-09-29T12:00:00.000Z',
      summary: 'Update "one"',
      details: { body: 'Hello' },
    },
  ];
  const { app } = buildApp({ activity });
  const res = await request(app).get('/api/campaigns/camp-1/activity?format=csv');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /"Update ""one"""/);
  assert.match(res.text, /"\{""body"":""Hello""\}"/);
});
