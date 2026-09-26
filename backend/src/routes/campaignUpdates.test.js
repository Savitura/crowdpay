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

function buildApp(queryImpl) {
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

test('POST /api/campaigns/:id/updates respects unsubscribe and creates update', async () => {
  const campaignId = '11111111-1111-1111-1111-111111111111';
  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT')) {
        return { rows: [{ id: campaignId, creator_id: 'user-1', title: 'Test' }] };
      }
      if (text.includes('INSERT INTO campaign_updates')) {
        return { rows: [{ id: 'up-1', campaign_id: campaignId, title: 'Update', body: 'Body' }] };
      }
      if (text.includes('SELECT email')) {
        return { rows: [{ email: 'unsub@test.com' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${campaignId}/updates`)
    .send({ title: 'New Update', body: 'Hello world' });

  assert.equal(res.status, 201);
  const unsubQuery = calls.find((c) => c.text.includes('campaign_update_unsubscribes'));
  assert.ok(unsubQuery);
  assert.deepEqual(unsubQuery.params, ['unsub@test.com', campaignId]);
});
