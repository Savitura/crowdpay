const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const CAMPAIGN_ID = 'camp-1';
const USER_ID = 'user-1';

const CAMPAIGN_ROW = { id: CAMPAIGN_ID, creator_id: USER_ID, title: 'Test Campaign' };
const THANK_YOU_ROW = {
  id: 'ty-1',
  campaign_id: CAMPAIGN_ID,
  creator_id: USER_ID,
  message: 'Thank you!',
  type: 'bulk',
  sent_at: '2024-01-01T00:00:00Z',
};

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

function buildApp({ queryImpl, role = 'user', authed = true } = {}) {
  const calls = {};

  const defaultQuery = async (sql, params) => {
    calls.lastQuery = { sql, params };
    if (sql.includes('SELECT id, creator_id, title FROM campaigns')) {
      return { rows: role === 'admin' ? [{ ...CAMPAIGN_ROW, creator_id: 'other-user' }] : [CAMPAIGN_ROW] };
    }
    if (sql.includes('INSERT INTO thank_you_messages')) {
      calls.insertParams = params;
      return { rows: [{ ...THANK_YOU_ROW, message: params[2] }] };
    }
    if (sql.includes('SELECT DISTINCT ON (u.id)')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const router = proxyquire('./thankYou', {
    '../config/database': { query: queryImpl || defaultQuery },
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: USER_ID, role };
            next();
          }
        : denyAuth(),
    },
    '../config/logger': { error: () => {} },
    '../services/emailService': { sendThankYouEmail: async () => {} },
    '../services/notifications': { createNotification: async () => {} },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/thank-you', router);

  return { app, calls };
}

test('POST /api/thank-you/:id/thank-you returns 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const res = await request(app)
    .post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`)
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 401);
});

test('POST /api/contributions/:id/thank-you returns 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const res = await request(app)
    .post('/api/contributions/contrib-1/thank-you')
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 401);
});

test('POST /api/contributions/:id/thank-you sends an individual thank-you to a contributor', async () => {
  const calls = {};
  const contributionRow = {
    id: 'contrib-1',
    campaign_id: CAMPAIGN_ID,
    sender_public_key: 'GBPUBKEY',
    creator_id: USER_ID,
    campaign_title: 'Test Campaign',
  };

  const queryImpl = async (sql, params) => {
    calls.lastQuery = { sql, params };
    if (sql.includes('SELECT ct.id, ct.campaign_id')) {
      return { rows: [contributionRow] };
    }
    if (sql.includes('INSERT INTO thank_you_messages')) {
      calls.insertParams = params;
      return {
        rows: [
          {
            id: 'ty-ind-1',
            campaign_id: CAMPAIGN_ID,
            creator_id: USER_ID,
            contribution_id: 'contrib-1',
            message: params[3],
            type: 'individual',
            sent_at: '2024-01-01T00:00:00Z',
          },
        ],
      };
    }
    return { rows: [] };
  };

  const { app } = buildApp({ queryImpl });

  const res = await request(app)
    .post('/api/contributions/contrib-1/thank-you')
    .send({ message: 'Great job!' });

  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'individual');
  assert.equal(res.body.contribution_id, 'contrib-1');
  assert.deepEqual(calls.insertParams, [CAMPAIGN_ID, USER_ID, 'contrib-1', 'Great job!']);
});

test('POST /api/contributions/:id/thank-you returns 404 for unknown contribution', async () => {
  const queryImpl = async (sql) => {
    if (sql.includes('SELECT ct.id, ct.campaign_id')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const { app } = buildApp({ queryImpl });

  const res = await request(app)
    .post('/api/contributions/contrib-999/thank-you')
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Contribution not found' });
});

test('POST /api/contributions/:id/thank-you returns 403 for non-creator', async () => {
  const contributionRow = {
    id: 'contrib-1',
    campaign_id: CAMPAIGN_ID,
    sender_public_key: 'GBPUBKEY',
    creator_id: 'other-creator',
    campaign_title: 'Test Campaign',
  };

  const queryImpl = async (sql) => {
    if (sql.includes('SELECT ct.id, ct.campaign_id')) {
      return { rows: [contributionRow] };
    }
    return { rows: [] };
  };

  const { app } = buildApp({ queryImpl, role: 'user' });

  const res = await request(app)
    .post('/api/contributions/contrib-1/thank-you')
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Only the campaign creator can send thank-you messages' });
});

test('POST /api/contributions/:id/thank-you allows admins for any contribution', async () => {
  const contributionRow = {
    id: 'contrib-1',
    campaign_id: CAMPAIGN_ID,
    sender_public_key: 'GBPUBKEY',
    creator_id: 'other-creator',
    campaign_title: 'Test Campaign',
  };

  const queryImpl = async (sql, params) => {
    if (sql.includes('SELECT ct.id, ct.campaign_id')) {
      return { rows: [contributionRow] };
    }
    if (sql.includes('INSERT INTO thank_you_messages')) {
      return {
        rows: [
          {
            id: 'ty-ind-1',
            campaign_id: CAMPAIGN_ID,
            creator_id: USER_ID,
            contribution_id: 'contrib-1',
            message: params[3],
            type: 'individual',
            sent_at: '2024-01-01T00:00:00Z',
          },
        ],
      };
    }
    return { rows: [] };
  };

  const { app } = buildApp({ queryImpl, role: 'admin' });

  const res = await request(app)
    .post('/api/contributions/contrib-1/thank-you')
    .send({ message: 'Admin thanks!' });

  assert.equal(res.status, 201);
});

test('POST /api/thank-you/:id/thank-you sends a bulk thank-you to the campaign', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`)
    .send({ message: 'Thank you!' });

  assert.deepEqual(res.body, {
    id: 'ty-1',
    campaign_id: CAMPAIGN_ID,
    creator_id: USER_ID,
    message: 'Thank you!',
    type: 'bulk',
    sent_at: '2024-01-01T00:00:00Z',
  });
  assert.deepEqual(calls.insertParams, [CAMPAIGN_ID, USER_ID, 'Thank you!']);
});

test('POST /api/thank-you/:id/thank-you rejects a missing message', async () => {
  const { app } = buildApp();

  const res = await request(app).post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`).send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error.message, 'Message is required');
});

test('POST /api/thank-you/:id/thank-you rejects messages over 500 characters', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`)
    .send({ message: 'x'.repeat(501) });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('POST /api/thank-you/:id/thank-you returns 404 for unknown campaign', async () => {
  const { app } = buildApp({
    queryImpl: async (sql) => (sql.includes('FROM campaigns') ? { rows: [] } : { rows: [] }),
  });

  const res = await request(app)
    .post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`)
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Campaign not found' });
});

test('POST /api/thank-you/:id/thank-you returns 403 for a non-creator', async () => {
  const { app } = buildApp({
    queryImpl: async (sql) => {
      if (sql.includes('FROM campaigns')) return { rows: [{ ...CAMPAIGN_ROW, creator_id: 'other' }] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`)
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Only the campaign creator can send thank-you messages' });
});

test('POST /api/thank-you/:id/thank-you allows admins for any campaign', async () => {
  const { app } = buildApp({ role: 'admin' });

  const res = await request(app)
    .post(`/api/thank-you/${CAMPAIGN_ID}/thank-you`)
    .send({ message: 'Thanks!' });

  assert.equal(res.status, 201);
});