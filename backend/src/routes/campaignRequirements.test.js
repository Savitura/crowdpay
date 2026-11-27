'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = 'creator-1';
const OTHER_USER_ID = 'user-2';

function buildApp({
  user = { userId: CREATOR_ID, role: 'creator' },
  campaignRow = { id: CAMPAIGN_ID, creator_id: CREATOR_ID },
  stored = null,
} = {}) {
  const calls = [];
  let current = stored;

  const router = proxyquire('./campaignRequirements', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        if (text.includes('FROM campaigns WHERE id')) {
          return { rows: campaignRow ? [campaignRow] : [] };
        }
        if (text.includes('INSERT INTO campaign_requirements')) {
          current = {
            id: 'requirement-1',
            campaign_id: params[0],
            min_reputation_score: params[1],
            required_attestations: JSON.parse(params[2]),
          };
          return { rows: [current] };
        }
        if (text.includes('FROM campaign_requirements WHERE campaign_id')) {
          return { rows: current ? [current] : [] };
        }
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
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

function insertCall(calls) {
  const call = calls.find(entry => entry.text.includes('INSERT INTO campaign_requirements'));
  assert.ok(call, 'expected an INSERT INTO campaign_requirements call');
  return call;
}

test('GET /api/campaigns/:id/requirements is public and returns defaults when unset', async () => {
  const { app, calls } = buildApp({ user: null });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/requirements`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    campaign_id: CAMPAIGN_ID,
    min_reputation_score: 0,
    required_attestations: [],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM campaign_requirements WHERE campaign_id/);
});

test('GET /api/campaigns/:id/requirements returns stored requirements', async () => {
  const stored = {
    id: 'requirement-1',
    campaign_id: CAMPAIGN_ID,
    min_reputation_score: 75,
    required_attestations: ['kyc_standard'],
  };
  const { app } = buildApp({ stored });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/requirements`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, stored);
});

test('GET /api/campaigns/:id/requirements rejects a non-UUID id with 422', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/campaigns/not-a-uuid/requirements');

  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error.message, 'Invalid request parameters');
  assert.equal(res.body.error.fields.id, 'Campaign id must be a valid UUID');
  assert.deepEqual(calls, []);
});

test('POST /api/campaigns/:id/requirements requires authentication', async () => {
  const { app, calls } = buildApp({ user: null });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({ min_reputation_score: 25 });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Unauthorized');
  assert.deepEqual(calls, []);
});

test('POST /api/campaigns/:id/requirements rejects a non-UUID id with 422', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/campaigns/not-a-uuid/requirements')
    .send({ min_reputation_score: 25 });

  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error.fields.id, 'Campaign id must be a valid UUID');
  assert.deepEqual(calls, []);
});

test('POST /api/campaigns/:id/requirements rejects invalid min_reputation_score values', async () => {
  for (const minReputationScore of [-1, 501, 'high']) {
    const { app, calls } = buildApp();

    const res = await request(app)
      .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
      .send({ min_reputation_score: minReputationScore });

    assert.equal(res.status, 422, `${minReputationScore} should be rejected`);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(
      res.body.error.fields.min_reputation_score,
      'min_reputation_score must be an integer between 0 and 500'
    );
    assert.deepEqual(calls, []);
  }
});

test('POST /api/campaigns/:id/requirements rejects invalid attestations', async () => {
  const notArray = buildApp();
  const notArrayRes = await request(notArray.app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({ required_attestations: 'kyc_basic' });

  assert.equal(notArrayRes.status, 422);
  assert.equal(notArrayRes.body.error.code, 'VALIDATION_ERROR');
  assert.match(notArrayRes.body.error.fields.required_attestations, /attestation/);
  assert.deepEqual(notArray.calls, []);

  const unknownType = buildApp();
  const unknownTypeRes = await request(unknownType.app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({ required_attestations: ['kyc_basic', 'unknown'] });

  assert.equal(unknownTypeRes.status, 422);
  assert.equal(
    unknownTypeRes.body.error.fields.required_attestations,
    'Each attestation must be one of: kyc_basic, kyc_standard, kyc_enhanced'
  );
  assert.deepEqual(unknownType.calls, []);
});

test('POST /api/campaigns/:id/requirements returns 404 for a missing campaign', async () => {
  const { app, calls } = buildApp({ campaignRow: null });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({ min_reputation_score: 25 });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Campaign not found');
  assert.ok(!calls.some(call => call.text.includes('INSERT INTO campaign_requirements')));
});

test('POST /api/campaigns/:id/requirements returns 403 for a non-creator', async () => {
  const { app, calls } = buildApp({ user: { userId: OTHER_USER_ID, role: 'contributor' } });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({ min_reputation_score: 25 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Only the campaign creator can set requirements');
  assert.ok(!calls.some(call => call.text.includes('INSERT INTO campaign_requirements')));
});

test('POST /api/campaigns/:id/requirements stores explicit requirements for the creator', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({ min_reputation_score: 120, required_attestations: ['kyc_basic', 'kyc_standard'] });

  assert.equal(res.status, 200);
  assert.equal(res.body.campaign_id, CAMPAIGN_ID);
  assert.equal(res.body.min_reputation_score, 120);
  assert.deepEqual(res.body.required_attestations, ['kyc_basic', 'kyc_standard']);
  assert.deepEqual(insertCall(calls).params, [
    CAMPAIGN_ID,
    120,
    JSON.stringify(['kyc_basic', 'kyc_standard']),
  ]);
});

test('POST /api/campaigns/:id/requirements defaults an empty body to zero and no attestations', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/requirements`)
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.min_reputation_score, 0);
  assert.deepEqual(res.body.required_attestations, []);
  assert.deepEqual(insertCall(calls).params, [CAMPAIGN_ID, 0, '[]']);
});

test('POST /api/campaigns/:id/requirements upserts and GET observes the updated state', async () => {
  const { app, calls } = buildApp();
  const url = `/api/campaigns/${CAMPAIGN_ID}/requirements`;

  const first = await request(app)
    .post(url)
    .send({ min_reputation_score: 10, required_attestations: ['kyc_basic'] });
  assert.equal(first.status, 200);
  assert.equal(first.body.min_reputation_score, 10);

  const second = await request(app)
    .post(url)
    .send({ min_reputation_score: 250, required_attestations: ['kyc_enhanced'] });
  assert.equal(second.status, 200);
  assert.equal(second.body.min_reputation_score, 250);
  assert.deepEqual(second.body.required_attestations, ['kyc_enhanced']);

  const inserts = calls.filter(call => call.text.includes('INSERT INTO campaign_requirements'));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].text, /ON CONFLICT \(campaign_id\) DO UPDATE/);
  assert.deepEqual(inserts[1].params, [
    CAMPAIGN_ID,
    250,
    JSON.stringify(['kyc_enhanced']),
  ]);

  const read = await request(app).get(url);
  assert.equal(read.status, 200);
  assert.equal(read.body.min_reputation_score, 250);
  assert.deepEqual(read.body.required_attestations, ['kyc_enhanced']);
});
