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

const realPublishing = require('../services/campaignUpdatesPublishing');

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const CREATOR_ID = 'creator-1';
const CAMPAIGN_TITLE = 'Save the Reef';

function buildApp({ updateRow = null } = {}) {
  const calls = [];
  const router = proxyquire('./campaignUpdates', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (text.includes('FROM campaigns')) {
          return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, title: CAMPAIGN_TITLE }] };
        }
        if (text.includes('FROM campaign_updates') && text.includes('WHERE id = $1')) {
          return { rows: updateRow ? [updateRow] : [] };
        }
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: CREATOR_ID, role: 'creator' };
        next();
      },
    },
    '../services/campaignUpdatesPublishing': {
      renderUpdate: realPublishing.renderUpdate,
      sendCampaignUpdateNotifications: async () => {},
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return { app, calls };
}

test('renderUpdate excerpt is the same representation used for notifications', () => {
  const body = 'x'.repeat(250);
  const rendered = realPublishing.renderUpdate({
    campaignId: CAMPAIGN_ID,
    campaignTitle: CAMPAIGN_TITLE,
    update: { title: 'T', body },
  });
  assert.equal(rendered.excerpt.length, 201); // 200 chars + ellipsis
  assert.ok(rendered.excerpt.endsWith('…'));
  assert.equal(rendered.notification_title, `${CAMPAIGN_TITLE}: T`);
  assert.match(rendered.link, new RegExp(`/campaigns/${CAMPAIGN_ID}$`));
});

test('POST /api/campaigns/:id/updates/preview sanitizes and formats like publication', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates/preview`)
    .send({ title: '<b>Hello</b>', body: '<p>Body <script>x</script>text</p>' });

  assert.equal(res.status, 200);
  const { preview } = res.body;
  // Same cleanText path as the create route (tags stripped, inner text kept).
  assert.equal(preview.title, 'Hello');
  assert.equal(preview.body, 'Body xtext');
  assert.equal(preview.status, 'published');
  assert.equal(preview.notification_title, `${CAMPAIGN_TITLE}: Hello`);
  assert.equal(preview.published_at, null);
});

test('POST preview normalizes a future schedule to UTC ISO-8601', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates/preview`)
    .send({ title: 'Later', body: 'soon', scheduled_for: '2030-01-02T03:04:05+02:00' });

  assert.equal(res.status, 200);
  assert.equal(res.body.preview.status, 'scheduled');
  assert.equal(res.body.scheduled_for_utc, '2030-01-02T01:04:05.000Z');
});

test('POST preview rejects an over-long body with 422', async () => {
  const { app } = buildApp();
  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/updates/preview`)
    .send({ title: 'T', body: 'y'.repeat(5001) });
  assert.equal(res.status, 422);
});

test('GET /api/campaigns/:id/updates/:updateId/preview renders a stored scheduled update', async () => {
  const updateRow = {
    id: 'update-1',
    campaign_id: CAMPAIGN_ID,
    author_id: CREATOR_ID,
    title: 'Scheduled',
    body: 'comes later',
    attachments: [],
    status: 'scheduled',
    scheduled_for: '2030-01-02T01:04:05.000Z',
    created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:00.000Z',
  };
  const { app } = buildApp({ updateRow });

  const res = await request(app).get(
    `/api/campaigns/${CAMPAIGN_ID}/updates/update-1/preview`
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.preview.status, 'scheduled');
  assert.equal(res.body.preview.published_at, null);
  assert.equal(res.body.scheduled_for_utc, '2030-01-02T01:04:05.000Z');
});

test('GET preview returns 404 for a missing update', async () => {
  const { app } = buildApp({ updateRow: null });
  const res = await request(app).get(
    `/api/campaigns/${CAMPAIGN_ID}/updates/missing/preview`
  );
  assert.equal(res.status, 404);
});
