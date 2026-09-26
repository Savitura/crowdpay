const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const USER_ID = 'user-1';

const PREVIEW = {
  id: 'invite-1',
  token: 'tok-1',
  campaign_id: 'camp-1',
  campaign_title: 'Test Campaign',
  inviter_name: 'Alice',
  role: 'founder',
  accepted_at: null,
  expired: false,
};

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

function buildApp({
  preview = PREVIEW,
  member = { id: 'member-1', user_id: USER_ID, role: 'founder' },
  userEmail = 'user@example.com',
  authed = true,
} = {}) {
  const calls = {};

  const router = proxyquire('./invites', {
    '../config/database': {
      query: async (sql, params) => {
        if (sql.includes('SELECT email FROM users')) {
          calls.userQueryParams = params;
          return { rows: userEmail ? [{ email: userEmail }] : [] };
        }
        return { rows: [] };
      },
    },
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: USER_ID };
            next();
          }
        : denyAuth(),
    },
    '../services/campaignInviteService': {
      getInvitePreview: async (token) => {
        calls.previewToken = token;
        return preview;
      },
      acceptCampaignInvite: async (opts) => {
        calls.acceptOpts = opts;
        return member;
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/invites', router);

  return { app, calls };
}

test('GET /api/invites/:token returns the invite preview', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/invites/tok-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, PREVIEW);
  assert.equal(calls.previewToken, 'tok-1');
});

test('GET /api/invites/:token returns 404 when invite is unknown', async () => {
  const { app } = buildApp({ preview: null });

  const res = await request(app).get('/api/invites/tok-1');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Invitation not found' });
});

test('GET /api/invites/:token returns 409 when invite is already accepted', async () => {
  const { app } = buildApp({ preview: { ...PREVIEW, accepted_at: '2024-01-01T00:00:00Z' } });

  const res = await request(app).get('/api/invites/tok-1');

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Invitation already accepted');
});

test('GET /api/invites/:token returns 410 when invite has expired', async () => {
  const { app } = buildApp({ preview: { ...PREVIEW, expired: true } });

  const res = await request(app).get('/api/invites/tok-1');

  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'Invitation has expired');
});

test('POST /api/invites/:token/accept accepts the invite with the user email', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).post('/api/invites/tok-1/accept');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'member-1', user_id: USER_ID, role: 'founder' });
  assert.deepEqual(calls.userQueryParams, [USER_ID]);
  assert.deepEqual(calls.acceptOpts, {
    inviteToken: 'tok-1',
    userId: USER_ID,
    userEmail: 'user@example.com',
  });
});

test('POST /api/invites/:token/accept tolerates a missing user email', async () => {
  const { app, calls } = buildApp({ userEmail: null });

  const res = await request(app).post('/api/invites/tok-1/accept');

  assert.equal(res.status, 200);
  assert.equal(calls.acceptOpts.userEmail, undefined);
});

test('POST /api/invites/:token/accept returns 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const res = await request(app).post('/api/invites/tok-1/accept');

  assert.equal(res.status, 401);
});