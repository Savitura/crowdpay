const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ campaignRow = { creator_id: 'creator-1' }, velocityImpl, updateThresholdImpl } = {}) {
  const creatorAnalyticsRouter = proxyquire('./creatorAnalytics', {
    '../services/velocityService': {
      getCampaignVelocity: velocityImpl || (async () => ({})),
      updateCampaignVelocityAlertThreshold: updateThresholdImpl || (async () => ({})),
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        req.user = { userId: 'creator-1', role: 'creator' };
        next();
      },
    },
    '../config/database': {
      query: async () => ({ rows: campaignRow ? [campaignRow] : [] }),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/creator', creatorAnalyticsRouter);
  return app;
}

test('GET /campaigns/:campaignId/velocity returns velocity data', async () => {
  const app = buildApp({
    velocityImpl: async () => ({
      campaignId: 'camp-1',
      velocityAlertThreshold: 0,
      raised7d: 100,
    }),
  });

  const res = await request(app).get('/api/creator/campaigns/camp-1/velocity');
  assert.equal(res.status, 200);
  assert.equal(res.body.velocityAlertThreshold, 0);
});

test('GET /campaigns/:campaignId/velocity 404s when the campaign does not exist', async () => {
  const app = buildApp({ campaignRow: null });
  const res = await request(app).get('/api/creator/campaigns/camp-1/velocity');
  assert.equal(res.status, 404);
});

test('GET /campaigns/:campaignId/velocity 403s for a non-creator, non-admin user', async () => {
  const app = buildApp({ campaignRow: { creator_id: 'someone-else' } });
  const res = await request(app).get('/api/creator/campaigns/camp-1/velocity');
  assert.equal(res.status, 403);
});

test('PATCH /campaigns/:campaignId/velocity/threshold updates threshold', async () => {
  const app = buildApp({
    updateThresholdImpl: async () => ({ success: true, velocityAlertThreshold: 200 }),
  });

  const res = await request(app)
    .patch('/api/creator/campaigns/camp-1/velocity/threshold')
    .send({ threshold: 200 });

  assert.equal(res.status, 200);
  assert.equal(res.body.velocityAlertThreshold, 200);
});

test('PATCH /campaigns/:campaignId/velocity/threshold validates negative or invalid threshold', async () => {
  const app = buildApp();

  const res = await request(app)
    .patch('/api/creator/campaigns/camp-1/velocity/threshold')
    .send({ threshold: -10 });

  assert.equal(res.status, 422);
  assert.ok(res.body.error);
});
