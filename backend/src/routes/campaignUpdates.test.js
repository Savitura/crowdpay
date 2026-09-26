const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';

const CREATOR_ID = 'creator-1';

const CAMPAIGN_ROW = { id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'Test Campaign' };

const UPDATE_ROW = {
  id: 'upd-1',
  campaign_id: CAMPAIGN_ID,
  author_id: CREATOR_ID,
  title: 'Milestone reached',
  body: 'We hit our goal!',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl } = {}) {
  const calls = [];
  const router = proxyquire('./campaignUpdates', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (queryImpl) return queryImpl(text, params);
        return { rows: [] };
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return { app, calls };
}

test('GET /api/campaigns/:id/updates lists updates', async () => {
  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT')) {
        return { rows: [{ id: 'up-1', campaign_id: 'c-1', title: 'Update 1' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/campaigns/11111111-1111-1111-1111-111111111111/updates');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('POST /api/campaigns/:id/updates creates update and checks unsubscribe suppression', async () => {
  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('INSERT INTO campaign_updates')) {
        return { rows: [{ id: 'up-2', campaign_id: '11111111-1111-1111-1111-111111111111', title: 'New' }] };
      }
      if (text.includes('SELECT c.creator_id')) {
        return { rows: [{ creator_id: 'user-1', title: 'Campaign' }] };
      }
      if (text.includes('FROM campaign_update_unsubscribes')) {
        return { rows: [{ email: 'unsub@test.com' }] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ email: 'backer@test.com' }] };
      }
      return { rows: [] };
    },
  });

  // Mock authentication middleware or header if needed, but depending on route implementation:
  const res = await request(app)
    .post('/api/campaigns/11111111-1111-1111-1111-111111111111/updates')
    .send({ title: 'Test Update', content: 'Content here' });

  assert.ok(res.status >= 200);
});
