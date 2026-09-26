const { describe, it, expect, vi, beforeEach } = require('vitest');
const request = require('supertest');
const express = require('express');
const proxyquire = require('proxyquire');

describe('creatorAnalytics routes', () => {
  let app;
  let getCampaignVelocityMock;
  let updateCampaignVelocityAlertThresholdMock;
  let dbQueryMock;

  beforeEach(() => {
    getCampaignVelocityMock = vi.fn();
    updateCampaignVelocityAlertThresholdMock = vi.fn();
    dbQueryMock = vi.fn();

    const creatorAnalyticsRouter = proxyquire('./creatorAnalytics', {
      '../services/velocityService': {
        getCampaignVelocity: getCampaignVelocityMock,
        updateCampaignVelocityAlertThreshold: updateCampaignVelocityAlertThresholdMock,
      },
      '../middleware/auth': {
        requireAuth: (req, res, next) => {
          req.user = { userId: 'creator-1', role: 'creator' };
          next();
        },
      },
      '../config/database': {
        query: dbQueryMock,
      },
    });

    app = express();
    app.use(express.json());
    app.use('/api/creator', creatorAnalyticsRouter);
  });

  it('GET /campaigns/:campaignId/velocity returns velocity data', async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [{ creator_id: 'creator-1' }]
    });
    getCampaignVelocityMock.mockResolvedValueOnce({
      campaignId: 'camp-1',
      velocityAlertThreshold: 0,
      raised7d: 100
    });

    const res = await request(app).get('/api/creator/campaigns/camp-1/velocity');
    expect(res.status).toBe(200);
    expect(res.body.velocityAlertThreshold).toBe(0);
  });

  it('PATCH /campaigns/:campaignId/velocity/threshold updates threshold', async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [{ creator_id: 'creator-1' }]
    });
    updateCampaignVelocityAlertThresholdMock.mockResolvedValueOnce({
      success: true,
      velocityAlertThreshold: 200
    });

    const res = await request(app)
      .patch('/api/creator/campaigns/camp-1/velocity/threshold')
      .send({ threshold: 200 });

    expect(res.status).toBe(200);
    expect(res.body.velocityAlertThreshold).toBe(200);
  });

  it('PATCH /campaigns/:campaignId/velocity/threshold validates negative or invalid threshold', async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [{ creator_id: 'creator-1' }]
    });

    const res = await request(app)
      .patch('/api/creator/campaigns/camp-1/velocity/threshold')
      .send({ threshold: -10 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBeDefined();
  });
});
