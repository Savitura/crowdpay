import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

const mockDb = {
  query: vi.fn(),
};

const mockVelocityService = {
  getCampaignVelocity: vi.fn(),
  updateCampaignVelocityAlertThreshold: vi.fn(),
};

vi.mock('../config/database', () => ({
  default: mockDb,
}));

vi.mock('../services/velocityService', () => ({
  getCampaignVelocity: (...args) => mockVelocityService.getCampaignVelocity(...args),
  updateCampaignVelocityAlertThreshold: (...args) => mockVelocityService.updateCampaignVelocityAlertThreshold(...args),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = req.user || { userId: 'creator-uuid-1', role: 'creator' };
    next();
  },
}));

const creatorAnalyticsRouter = require('./creatorAnalytics');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/creator', creatorAnalyticsRouter);
  return app;
}

describe('creatorAnalytics velocity routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/creator/campaigns/:campaignId/velocity returns campaign velocity data when authorized', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ creator_id: 'creator-uuid-1' }],
    });
    mockVelocityService.getCampaignVelocity.mockResolvedValueOnce({
      campaignId: 'c1',
      velocity_alert_threshold: 50,
      weekly: 100,
    });

    const app = buildApp();
    const res = await request(app).get('/api/creator/campaigns/c1/velocity');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      campaignId: 'c1',
      velocity_alert_threshold: 50,
      weekly: 100,
    });
  });

  it('PATCH /api/creator/campaigns/:campaignId/velocity/threshold updates threshold when valid', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ creator_id: 'creator-uuid-1' }],
    });
    mockVelocityService.updateCampaignVelocityAlertThreshold.mockResolvedValueOnce({
      campaignId: 'c1',
      velocity_alert_threshold: 250,
    });

    const app = buildApp();
    const res = await request(app)
      .patch('/api/creator/campaigns/c1/velocity/threshold')
      .send({ threshold: 250 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      campaignId: 'c1',
      velocity_alert_threshold: 250,
    });
    expect(mockVelocityService.updateCampaignVelocityAlertThreshold).toHaveBeenCalledWith('c1', 250);
  });

  it('PATCH /api/creator/campaigns/:campaignId/velocity/threshold rejects invalid threshold', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ creator_id: 'creator-uuid-1' }],
    });

    const app = buildApp();
    const res = await request(app)
      .patch('/api/creator/campaigns/c1/velocity/threshold')
      .send({ threshold: -10 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBeDefined();
    expect(mockVelocityService.updateCampaignVelocityAlertThreshold).not.toHaveBeenCalled();
  });
});
