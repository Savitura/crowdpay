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
  const url = buildUnsubscribeUrl({ email: 'a@test.com', category: 'campaign_update' });
  const path = url.split('/api/emails')[1];

  const res = await request(app).get(`/api/emails${path}`);

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
