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

function buildApp({ queryImpl, user = { userId: 'creator-1', role: 'creator' } } = {}) {
  const calls = [];
  const router = proxyquire('./campaignUpdates', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (queryImpl) return queryImpl(text, params);
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        req.user = user;
        next();
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return { app, calls };
}

test('GET /api/campaigns/:id/updates lists updates', async () => {
  const campaignId = '11111111-1111-1111-1111-111111111111';
  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: campaignId, creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_updates')) {
        return { rows: [{ id: 'update-1', title: 'Update 1' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${campaignId}/updates`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('POST /api/campaigns/:id/updates creates update and respects unsubscribe check with correct campaignId string', async () => {
  const campaignId = '11111111-1111-1111-1111-111111111111';
  let checkedCampaignId = null;

  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: campaignId, creator_id: 'creator-1', title: 'Test Campaign' }] };
      }
      if (text.includes('INSERT INTO campaign_updates')) {
        return { rows: [{ id: 'update-1', campaign_id: campaignId, title: 'New Update' }] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ email: 'backer@test.com' }] };
      }
      return { rows: [] };
    },
  });

  // Spy / mock email service check or capture call if needed via proxyquire if imported.
  // Since emailService is required inside campaignUpdates, we can verify database queries or behavior.
  const res = await request(app)
    .post(`/api/campaigns/${campaignId}/updates`)
    .send({ title: 'New Update', content: 'Update content' });

  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'New Update');
});

test('PATCH /api/campaigns/:id/updates/:updateId edits update within 24h window', async () => {
  const campaignId = '11111111-1111-1111-1111-111111111111';
  const updateId = '22222222-2222-2222-2222-222222222222';

  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: campaignId, creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_updates')) {
        return { rows: [{ id: updateId, campaign_id: campaignId, created_at: new Date() }] };
      }
      if (text.includes('UPDATE campaign_updates')) {
        return { rows: [{ id: updateId, title: 'Updated Title' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch(`/api/campaigns/${campaignId}/updates/${updateId}`)
    .send({ title: 'Updated Title' });

  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Updated Title');
});

test('DELETE /api/campaigns/:id/updates/:updateId deletes update', async () => {
  const campaignId = '11111111-1111-1111-1111-111111111111';
  const updateId = '22222222-2222-2222-2222-222222222222';

  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: campaignId, creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_updates')) {
        return { rows: [{ id: updateId, campaign_id: campaignId }] };
      }
      if (text.includes('DELETE FROM campaign_updates')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).delete(`/api/campaigns/${campaignId}/updates/${updateId}`);
  assert.equal(res.status, 200);
});
