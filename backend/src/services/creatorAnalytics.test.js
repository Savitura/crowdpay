const { describe, it, expect, vi, beforeEach } = require('vitest');
const proxyquire = require('proxyquire');

describe('creatorAnalytics velocity service', () => {
  let dbQueryMock;
  let getCampaignVelocity;
  let updateCampaignVelocityAlertThreshold;

  beforeEach(() => {
    dbQueryMock = vi.fn();
    const velocityService = proxyquire('./velocityService', {
      '../config/database': {
        query: dbQueryMock,
      },
    });
    getCampaignVelocity = velocityService.getCampaignVelocity;
    updateCampaignVelocityAlertThreshold = velocityService.updateCampaignVelocityAlertThreshold;
  });

  it('gets campaign velocity including velocity_alert_threshold', async () => {
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'camp-1',
          category: 'technology',
          target_amount: 1000,
          raised_amount: 250,
          deadline: '2025-12-31',
          velocity_alert_threshold: 50
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ category_avg_weekly: 100 }] });

    const result = await getCampaignVelocity('camp-1');
    expect(result).toBeDefined();
    expect(result.velocityAlertThreshold).toBe(50);
  });

  it('updates campaign velocity alert threshold successfully', async () => {
    dbQueryMock.mockResolvedValueOnce({
      rows: [{
        id: 'camp-1',
        velocity_alert_threshold: 150
      }]
    });

    const result = await updateCampaignVelocityAlertThreshold('camp-1', 150);
    expect(result).toEqual({ success: true, velocityAlertThreshold: 150 });
    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE campaigns SET velocity_alert_threshold'),
      [150, 'camp-1']
    );
  });
});
