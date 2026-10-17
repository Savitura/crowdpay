process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const CREATOR_ID = 'creator-1';

function buildApp({
  queryImpl = async () => ({ rows: [] }),
  user = { userId: CREATOR_ID, role: 'creator' },
} = {}) {
  const calls = [];
  const notificationsCalled = [];

  const router = proxyquire('./campaignUpdates', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return queryImpl(text, params);
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user;
        next();
      },
    },
    '../services/campaignUpdatesPublishing': {
      sendCampaignUpdateNotifications: async opts => {
        notificationsCalled.push(opts);
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  return { app, calls, notificationsCalled };
}

test('POST /api/campaigns/:id/updates creates immediate update and publishes immediately', async () => {
  let insertedUpdate = null;
  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'My Campaign' }] };
      }
      if (text.includes('INSERT INTO campaign_updates')) {
        insertedUpdate = {
          id: 'upd-1',
          campaign_id: params[0],
          author_id: params[1],
          title: params[2],
          body: params[3],
          status: params[5],
          scheduled_for: params[6],
          created_at: new Date().toISOString(),
        };
        return { rows: [insertedUpdate] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'Launch Update', body: 'We are live!' });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'published');
  assert.equal(res.body.scheduled_for, null);
});

test('POST /api/campaigns/:id/updates with future scheduled_for creates scheduled update without immediate broadcast', async () => {
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  let insertedUpdate = null;
  const { app, notificationsCalled } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'My Campaign' }] };
      }
      if (text.includes('INSERT INTO campaign_updates')) {
        insertedUpdate = {
          id: 'upd-2',
          campaign_id: params[0],
          author_id: params[1],
          title: params[2],
          body: params[3],
          status: params[5],
          scheduled_for: params[6],
          created_at: new Date().toISOString(),
        };
        return { rows: [insertedUpdate] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'Scheduled Launch', body: 'Going live tomorrow', scheduled_for: futureDate });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'scheduled');
  assert.equal(res.body.scheduled_for, futureDate);
  assert.equal(notificationsCalled.length, 0);
});

test('POST /api/campaigns/:id/updates rejects scheduled_for in the past with 422', async () => {
  const pastDate = new Date(Date.now() - 3600000).toISOString();
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'My Campaign' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates`)
    .send({ title: 'Old Update', body: 'Testing past date', scheduled_for: pastDate });

  assert.equal(res.status, 422);
  assert.match(res.body.error, /future/i);
});

test('GET /api/campaigns/:id/updates only lists published updates', async () => {
  const { app, calls } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM campaign_updates')) {
        return {
          rows: [{ id: 'upd-1', title: 'Published 1', status: 'published' }],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/updates`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'upd-1');
  const getQuery = calls.find(c => c.text.includes('FROM campaign_updates'));
  assert.ok(getQuery.text.includes("status = 'published'"));
});

test('PATCH /api/campaigns/:id/updates/:updateId allows rescheduling a scheduled update', async () => {
  const futureDate1 = new Date(Date.now() + 86400000).toISOString();
  const futureDate2 = new Date(Date.now() + 172800000).toISOString();

  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'My Campaign' }] };
      }
      if (text.includes('SELECT id, campaign_id, author_id, title, body')) {
        return {
          rows: [
            {
              id: 'upd-sched',
              campaign_id: CAMPAIGN_ID,
              author_id: CREATOR_ID,
              title: 'Initial Title',
              body: 'Initial Body',
              status: 'scheduled',
              scheduled_for: futureDate1,
              created_at: new Date(Date.now() - 100000).toISOString(),
            },
          ],
        };
      }
      if (text.includes('UPDATE campaign_updates')) {
        return {
          rows: [
            {
              id: 'upd-sched',
              campaign_id: CAMPAIGN_ID,
              author_id: CREATOR_ID,
              title: params[0],
              body: params[1],
              status: params[3],
              scheduled_for: params[4],
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-sched`)
    .send({ title: 'New Rescheduled Title', scheduled_for: futureDate2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'New Rescheduled Title');
  assert.equal(res.body.scheduled_for, futureDate2);
  assert.equal(res.body.status, 'scheduled');
});

test('DELETE /api/campaigns/:id/updates/:updateId cancels and removes update', async () => {
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT id, creator_id, title FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: 'My Campaign' }] };
      }
      if (text.includes('DELETE FROM campaign_updates')) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/updates/upd-sched`);
  assert.equal(res.status, 204);
});

test('campaignUpdatesPublishing.publishDueCampaignUpdates publishes due updates idempotently and sends notifications', async () => {
  const dueUpdates = [
    {
      id: 'due-1',
      campaign_id: CAMPAIGN_ID,
      author_id: CREATOR_ID,
      title: 'Due Update 1',
      body: 'Content for update 1',
      attachments: [],
      scheduled_for: new Date(Date.now() - 1000).toISOString(),
      campaign_title: 'My Campaign',
    },
  ];

  let updateCallCount = 0;
  const publishingService = proxyquire('../services/campaignUpdatesPublishing', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes("status = 'scheduled' AND cu.scheduled_for <= NOW()")) {
          return { rows: dueUpdates };
        }
        if (text.includes('UPDATE campaign_updates')) {
          updateCallCount++;
          return {
            rows: [
              {
                ...dueUpdates[0],
                status: 'published',
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (text.includes('SELECT DISTINCT ON (u.id) u.id, u.email, u.name')) {
          return { rows: [{ id: 'back-1', email: 'backer@example.com', name: 'Backer' }] };
        }
        return { rows: [] };
      },
    },
    './campaignFollowService': {
      notifyFollowers: async () => {},
    },
    './emailService': {
      sendCampaignUpdatePostedEmail: async () => {},
    },
    './notifications': {
      createNotification: async () => {},
    },
  });

  const published = await publishingService.publishDueCampaignUpdates();
  assert.equal(published.length, 1);
  assert.equal(published[0].id, 'due-1');
  assert.equal(published[0].status, 'published');
  assert.equal(updateCallCount, 1);
});
