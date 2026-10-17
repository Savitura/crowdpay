process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '33333333-3333-3333-3333-333333333333';
const CREATOR_ID = 'creator-1';

function buildApp({
  forecastImpl = async () => ({
    campaign_id: CAMPAIGN_ID, horizon_months: 6, projected_total_payout: 600,
    months: [{ month: '2026-10', projected_payout: 100 }],
  }),
  reserveImpl = async () => ({
    campaign_id: CAMPAIGN_ID, balance: 1000, reserve: 175, available: 825,
    breakdown: { platform_fees: 25, pending_withdrawals: 100, scheduled_payouts: 50 },
  }),
  campaignCreator = CREATOR_ID,
  user = { userId: CREATOR_ID, role: 'creator' },
} = {}) {
  const router = proxyquire('../routes/payoutForecast', {
    '../middleware/auth': {
      requireAuth: (req, _res, next) => { req.user = user; next(); },
    },
    '../services/payoutForecastService': {
      getPayoutForecast: forecastImpl,
      getReserveBreakdown: reserveImpl,
    },
    './creatorAnalytics': {
      requireCampaignCreatorOrMember: (req, res, next) => {
        if (req.user.userId !== campaignCreator && req.user.role !== 'admin') {
          return res.status(403).json({ error: 'Forbidden' });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/creator', router);
  return { app };
}

test('GET payout-forecast returns projected months for the creator', async () => {
  const { app } = buildApp();
  const res = await request(app)
    .get(`/api/creator/campaigns/${CAMPAIGN_ID}/payout-forecast?horizon=6`);
  assert.equal(res.status, 200);
  assert.equal(res.body.horizon_months, 6);
  assert.equal(res.body.projected_total_payout, 600);
  assert.equal(res.body.months.length, 1);
});

test('GET payout-forecast defaults horizon to 6 when omitted', async () => {
  let captured;
  const { app } = buildApp({
    forecastImpl: async (id, opts) => { captured = opts; return { campaign_id: id, months: [] }; },
  });
  await request(app).get(`/api/creator/campaigns/${CAMPAIGN_ID}/payout-forecast`);
  assert.equal(captured.horizonMonths, 6);
});

test('GET payout-forecast rejects out-of-range horizon with 422', async () => {
  const { app } = buildApp();
  for (const bad of ['0', '25', '-1', 'abc', '99']) {
    const res = await request(app)
      .get(`/api/creator/campaigns/${CAMPAIGN_ID}/payout-forecast?horizon=${bad}`);
    assert.equal(res.status, 422, `horizon=${bad} should 422`);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
});

test('GET payout-forecast returns 404 when the campaign has no forecast', async () => {
  const { app } = buildApp({ forecastImpl: async () => null });
  const res = await request(app)
    .get(`/api/creator/campaigns/${CAMPAIGN_ID}/payout-forecast`);
  assert.equal(res.status, 404);
});

test('GET reserve returns the reserve breakdown', async () => {
  const { app } = buildApp();
  const res = await request(app).get(`/api/creator/campaigns/${CAMPAIGN_ID}/reserve`);
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, 1000);
  assert.equal(res.body.reserve, 175);
  assert.equal(res.body.available, 825);
});

test('GET reserve returns 404 when campaign missing', async () => {
  const { app } = buildApp({ reserveImpl: async () => null });
  const res = await request(app).get(`/api/creator/campaigns/${CAMPAIGN_ID}/reserve`);
  assert.equal(res.status, 404);
});

test('non-owner without admin role gets 403 on both endpoints', async () => {
  const { app } = buildApp({ user: { userId: 'someone-else', role: 'contributor' } });
  const f = await request(app).get(`/api/creator/campaigns/${CAMPAIGN_ID}/payout-forecast`);
  const r = await request(app).get(`/api/creator/campaigns/${CAMPAIGN_ID}/reserve`);
  assert.equal(f.status, 403);
  assert.equal(r.status, 403);
});

test('admin can read another creator forecast', async () => {
  const { app } = buildApp({ user: { userId: 'admin-1', role: 'admin' } });
  const res = await request(app)
    .get(`/api/creator/campaigns/${CAMPAIGN_ID}/payout-forecast`);
  assert.equal(res.status, 200);
});
