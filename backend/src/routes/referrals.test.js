const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const USER_ID = 'user-1';

function denyAuth() {
  return (_req, res) => res.status(401).json({ error: 'Unauthorized' });
}

function buildApp({ referralService = {}, referral = {}, authed = true } = {}) {
  const calls = {};

  const router = proxyquire('./referrals', {
    '../middleware/auth': {
      requireAuth: authed
        ? (req, _res, next) => {
            req.user = { userId: USER_ID };
            next();
          }
        : denyAuth(),
    },
    '../services/referralService': {
      getLeaderboard: async (opts) => {
        calls.leaderboardOpts = opts;
        return [{ id: 'u1', totalEarned: 10 }];
      },
      getUserRewards: async (userId, opts) => {
        calls.rewardsArgs = [userId, opts];
        return { rewards: [], total: 0 };
      },
      getUserRewardSummary: async (userId) => {
        calls.summaryUserId = userId;
        return { totalEarned: 0, paidOut: 0, pending: 0 };
      },
      getReferralAnalytics: async (userId) => {
        calls.analyticsUserId = userId;
        return { clicks: 1, conversions: 0 };
      },
      getUserFraudChecks: async (userId, opts) => {
        calls.fraudArgs = [userId, opts];
        return { checks: [], total: 0 };
      },
      resolveFraudCheck: async (id, userId) => {
        calls.resolveArgs = [id, userId];
      },
      ...referralService,
    },
    '../services/referral': {
      listUserReferralLinks: async (userId) => {
        calls.linksUserId = userId;
        return [{ code: 'abc' }];
      },
      ...referral,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/referrals', router);

  return { app, calls };
}

test('GET /api/referrals/leaderboard returns leaderboard and clamps limit/offset', async () => {
  const { app, calls } = buildApp();
  const res = await request(app).get('/api/referrals/leaderboard?limit=500&offset=-5');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { leaderboard: [{ id: 'u1', totalEarned: 10 }] });
  assert.deepEqual(calls.leaderboardOpts, { limit: 100, offset: 0 });
});

test('GET /api/referrals/leaderboard passes default limit/offset', async () => {
  const { app, calls } = buildApp();
  await request(app).get('/api/referrals/leaderboard');

  assert.deepEqual(calls.leaderboardOpts, { limit: 20, offset: 0 });
});

test('GET /api/referrals/links returns referral links for authenticated user', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/referrals/links');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { links: [{ code: 'abc' }] });
  assert.equal(calls.linksUserId, USER_ID);
});

test('GET /api/referrals/links returns 401 without auth', async () => {
  const { app } = buildApp({ authed: false });

  const res = await request(app).get('/api/referrals/links');

  assert.equal(res.status, 401);
});

test('GET /api/referrals/rewards passes status filter to service', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/referrals/rewards?status=earned');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rewards: [], total: 0 });
  assert.deepEqual(calls.rewardsArgs, [USER_ID, { status: 'earned' }]);
});

test('GET /api/referrals/rewards forwards undefined status when omitted', async () => {
  const { app, calls } = buildApp();

  await request(app).get('/api/referrals/rewards');

  assert.deepEqual(calls.rewardsArgs, [USER_ID, { status: undefined }]);
});

test('GET /api/referrals/rewards/summary returns reward summary', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/referrals/rewards/summary');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { totalEarned: 0, paidOut: 0, pending: 0 });
  assert.equal(calls.summaryUserId, USER_ID);
});

test('GET /api/referrals/analytics returns analytics for user', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/referrals/analytics');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { clicks: 1, conversions: 0 });
  assert.equal(calls.analyticsUserId, USER_ID);
});

test('GET /api/referrals/fraud-checks maps resolved=true', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).get('/api/referrals/fraud-checks?resolved=true');

  assert.equal(res.status, 200);
  assert.deepEqual(calls.fraudArgs, [USER_ID, { resolved: true }]);
});

test('GET /api/referrals/fraud-checks maps resolved=false', async () => {
  const { app, calls } = buildApp();

  await request(app).get('/api/referrals/fraud-checks?resolved=false');

  assert.deepEqual(calls.fraudArgs, [USER_ID, { resolved: false }]);
});

test('GET /api/referrals/fraud-checks omits filter when flag absent', async () => {
  const { app, calls } = buildApp();

  await request(app).get('/api/referrals/fraud-checks');

  assert.deepEqual(calls.fraudArgs, [USER_ID, { resolved: undefined }]);
});

test('POST /api/referrals/fraud-checks/:id/resolve resolves the check', async () => {
  const { app, calls } = buildApp();

  const res = await request(app).post('/api/referrals/fraud-checks/check-1/resolve');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls.resolveArgs, ['check-1', USER_ID]);
});