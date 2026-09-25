const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = 'camp-1';
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

function buildApp({
  queryImpl,
  creatorId = CREATOR_ID,
  role = 'user',
  authed = true,
} = {}) {
  const calls = {};

  const defaultQuery = async (sql, params) => {
    calls.lastQuery = { sql, params };
    if (sql.includes('SELECT id, creator_id, title FROM campaigns')) {
      return { rows: creatorId ? [{ ...CAMPAIGN_ROW, creator_id: creatorId }] : [] };
    }
    if (sql.includes('INSERT INTO campaign_updates')) {
      calls.insertParams = params;
      return { rows: [UPDATE_ROW] };
    }
    if (sql.includes('UPDATE campaign_updates')) {
      calls.updateParams = params;
      return { rows: [UPDATE_ROW] };
    }
    if (sql.includes('DELETE FROM campaign_updates')) {
      calls.deleteParams = params;
      return { rowCount: 1 };
    }
    if (sql.includes('SELECT DISTINCT ON (u.id)')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT cu.id')) {
      return { rows: [UPDATE_ROW] };
    }
    return { rows: [] };
  };

  const router = proxyquire('./campaignUpdates', {
    '../config/database': { query: queryImpl || defaultQuery },
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: CREATOR_ID, role };
            next();
          }
        : denyAuth(),
    },
    '../middleware/validation': { CAMPAIGN_UPDATE_BODY_MAX_LENGTH: 5000 },
    '../config/logger': { error: () => {} },
    '../services/emailService': { sendCampaignUpdatePostedEmail: async () => {} },
    '../services/notifications': { createNotification: async () => {} },
    '../services/campaignFollowService': { notifyFollowers: async () => {} },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  return { app, calls };
}

test('GET /api/campaigns/:id/updates is public and lists updates', async () => {
  const { app } = buildApp();

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/updates`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [UPDATE_ROW]);
});

test('POST /api/campaigns/:id/updates returns 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'T', body: 'B' });

  assert.equal(res.status, 401);
});

test('POST /api/campaigns/:id/updates returns 404 for unknown campaign', async () => {
  const { app } = buildApp({ creatorId: null });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'T', body: 'B' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});

test('POST /api/campaigns/:id/updates returns 403 for non-creator', async () => {
  const { app } = buildApp({ creatorId: 'other-user' });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'T', body: 'B' });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Only the campaign creator can manage updates' });
});

test('POST /api/campaigns/:id/updates allows admins', async () => {
  const { app } = buildApp({ creatorId: 'other-user', role: 'admin' });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'T', body: 'B' });

  assert.equal(res.status, 201);
});

test('POST /api/campaigns/:id/updates creates update and stores cleaned text', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: '<h1>Milestone reached</h1>', body: '  We hit <b>our goal</b>!\n ' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, UPDATE_ROW);
  assert.deepEqual(calls.insertParams, [
    CAMPAIGN_ID,
    CREATOR_ID,
    'Milestone reached',
    'We hit our goal!',
  ]);
});

test('POST /api/campaigns/:id/updates rejects missing title', async () => {
  const { app } = buildApp();

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/updates`).send({ body: 'B' });

  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: 'Title is required' });
});

test('POST /api/campaigns/:id/updates rejects missing body', async () => {
  const { app } = buildApp();

  const res = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/updates`).send({ title: 'T' });

  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: 'Body is required' });
});

test('POST /api/campaigns/:id/updates rejects body over the limit', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'T', body: 'x'.repeat(5001) });

  assert.equal(res.status, 422);
});

test('PATCH /api/campaigns/:id/updates/:updateId edits within the window', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-1`)
    .send({ title: 'Updated', body: 'New body' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, UPDATE_ROW);
  assert.deepEqual(calls.updateParams, [
    'Updated',
    'New body',
    'upd-1',
    CAMPAIGN_ID,
    CREATOR_ID,
  ]);
});

test('PATCH /api/campaigns/:id/updates/:updateId returns 403 when edit window expired', async () => {
  const { app } = buildApp({
    queryImpl: async (sql, _params) => {
      if (sql.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [CAMPAIGN_ROW] };
      }
      if (sql.includes('UPDATE campaign_updates')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-1`)
    .send({ title: 'Updated', body: 'New body' });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Update not found or edit window has expired' });
});

test('PATCH /api/campaigns/:id/updates/:updateId validates input', async () => {
  const { app } = buildApp();

  const missingBody = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-1`)
    .send({ title: 'T' });
  assert.equal(missingBody.status, 422);

  const missingTitle = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-1`)
    .send({ body: 'B' });
  assert.equal(missingTitle.status, 422);
});

test('DELETE /api/campaigns/:id/updates/:updateId deletes the update', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-1`);

  assert.equal(res.status, 204);
  assert.deepEqual(calls.deleteParams, ['upd-1', CAMPAIGN_ID, CREATOR_ID]);
});

test('DELETE /api/campaigns/:id/updates/:updateId returns 404 when nothing deleted', async () => {
  const { app } = buildApp({
    queryImpl: async (sql, _params) => {
      if (sql.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [CAMPAIGN_ROW] };
      }
      if (sql.includes('DELETE FROM campaign_updates')) {
        return { rowCount: 0 };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-1`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Update not found' });
});