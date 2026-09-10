const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { buildUnsubscribeUrl } = require('../utils/unsubscribeToken');

function buildApp({ queryImpl } = {}) {
  const calls = [];
  const router = proxyquire('./emails', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (queryImpl) return queryImpl(text, params);
        return { rows: [] };
      },
    },
  });
  const app = express();
  app.use('/api/emails', router);
  return { app, calls };
}

test('GET /api/emails/unsubscribe records unsubscribe for a valid signed link', async () => {
  const { app, calls } = buildApp();
  const frontendUrl = buildUnsubscribeUrl({ email: 'a@test.com', category: 'campaign_update' });
  const parsed = new URL(frontendUrl);
  const queryString = parsed.search;

  const res = await request(app).get(`/api/emails/unsubscribe${queryString}`);

  assert.equal(res.status, 200);
  const insertCall = calls.find((c) => c.text.includes('INSERT INTO email_unsubscribes'));
  assert.ok(insertCall);
  assert.deepEqual(insertCall.params, ['a@test.com', 'campaign_update']);
});

test('GET /api/emails/unsubscribe rejects a tampered signature', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .get('/api/emails/unsubscribe')
    .query({ email: 'a@test.com', category: 'campaign_update', sig: 'not-the-real-signature' });

  assert.equal(res.status, 400);
});

// --- campaign_id validation (#490) -------------------------------------------
//
// campaign_id is a UUID column (campaign_update_unsubscribes.campaign_id
// references campaigns(id)); it was previously coerced with Number(campaignId),
// which is always NaN for a real UUID and silently broke both signature
// verification and the insert. These tests cover a valid UUID campaign_id
// round-tripping correctly, and a malformed campaign_id being rejected with 400
// instead of hitting the database.

test('GET /api/emails/unsubscribe records a campaign-scoped unsubscribe for a valid UUID campaign_id', async () => {
  const campaignId = '11111111-1111-1111-1111-111111111111';
  const { app, calls } = buildApp();
  const frontendUrl = buildUnsubscribeUrl({ email: 'a@test.com', category: 'campaign_update', campaignId });
  const parsed = new URL(frontendUrl);
  const queryString = parsed.search;

  const res = await request(app).get(`/api/emails/unsubscribe${queryString}`);

  assert.equal(res.status, 200);
  const insertCall = calls.find((c) => c.text.includes('INSERT INTO campaign_update_unsubscribes'));
  assert.ok(insertCall);
  assert.deepEqual(insertCall.params, ['a@test.com', campaignId]);
});

test('GET /api/emails/unsubscribe returns 400 for a malformed campaign_id', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .get('/api/emails/unsubscribe')
    .query({
      email: 'a@test.com',
      category: 'campaign_update',
      sig: 'irrelevant-checked-after-campaign_id',
      campaign_id: 'not-a-uuid',
    });

  assert.equal(res.status, 400);
});
