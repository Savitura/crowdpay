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
    '../services/emailService': {
      sendEmail: async () => {},
      sendCampaignUpdateEmail: async () => {},
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/campaign-updates', router);
  return { app, calls };
}

test('GET /api/campaign-updates lists updates for a campaign', async () => {
  const { app, calls } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT')) {
        return { rows: [{ id: 'up-1', title: 'Update 1' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/campaign-updates?campaign_id=11111111-1111-1111-1111-111111111111');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'up-1');
});
