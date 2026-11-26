'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMilestonePercentages } = require('../../scripts/validate-milestone-percentages');

test('validateMilestonePercentages returns empty invalidCampaigns when all totals <= 100%', async () => {
  const mockDb = {
    query: async () => ({
      rows: [
        {
          campaign_id: 'c1',
          campaign_title: 'Campaign 1',
          milestone_count: 2,
          total_percentage: 100,
          campaign_status: 'active',
          milestone_details: 'Phase 1 (50%), Phase 2 (50%)',
          exceeds_100_percent: false,
        },
        {
          campaign_id: 'c2',
          campaign_title: 'Campaign 2',
          milestone_count: 1,
          total_percentage: 99.5,
          campaign_status: 'active',
          milestone_details: 'Phase 1 (99.5%)',
          exceeds_100_percent: false,
        },
      ],
    }),
  };

  const result = await validateMilestonePercentages(mockDb);
  assert.equal(result.invalidCampaigns.length, 0);
  assert.equal(result.validCampaigns.length, 2);
});

test('validateMilestonePercentages isolates campaigns exceeding 100% total', async () => {
  const mockDb = {
    query: async () => ({
      rows: [
        {
          campaign_id: 'c-invalid',
          campaign_title: 'Exceeding Campaign',
          milestone_count: 3,
          total_percentage: 120,
          campaign_status: 'active',
          milestone_details: 'M1 (50%), M2 (50%), M3 (20%)',
          exceeds_100_percent: true,
        },
        {
          campaign_id: 'c-valid',
          campaign_title: 'Valid Campaign',
          milestone_count: 1,
          total_percentage: 100,
          campaign_status: 'active',
          milestone_details: 'M1 (100%)',
          exceeds_100_percent: false,
        },
      ],
    }),
  };

  const result = await validateMilestonePercentages(mockDb);
  assert.equal(result.invalidCampaigns.length, 1);
  assert.equal(result.invalidCampaigns[0].campaign_id, 'c-invalid');
  assert.equal(result.validCampaigns.length, 1);
  assert.equal(result.validCampaigns[0].campaign_id, 'c-valid');
});

test('validateMilestonePercentages propagates database query errors', async () => {
  const mockDb = {
    query: async () => {
      throw new Error('connection timeout');
    },
  };

  await assert.rejects(
    async () => {
      await validateMilestonePercentages(mockDb);
    },
    {
      name: 'Error',
      message: 'connection timeout',
    }
  );
});
