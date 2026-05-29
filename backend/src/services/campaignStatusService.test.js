const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('refreshActiveCampaignStatuses marks funded and failed campaigns', async () => {
  const queries = [];
  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text) => {
        queries.push(text);
        if (text.includes("SET status = 'funded'")) {
          return { rows: [{ id: 'funded-1', status: 'funded' }] };
        }
        if (text.includes("SET status = 'failed'")) {
          return { rows: [{ id: 'failed-1', status: 'failed' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
  });

  const result = await refreshActiveCampaignStatuses();
  assert.equal(result.funded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.ok(queries.some((q) => q.includes("SET status = 'funded'")));
  assert.ok(queries.some((q) => q.includes("SET status = 'failed'")));
});

test('refreshCampaignStatus updates a single campaign', async () => {
  const { refreshCampaignStatus } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text, params) => {
        assert.equal(params[0], 'camp-uuid');
        if (text.includes("SET status = 'failed'")) return { rows: [] };
        if (text.includes("SET status = 'funded'")) {
          return { rows: [{ id: 'camp-uuid', status: 'funded' }] };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
  });

  const result = await refreshCampaignStatus('camp-uuid');
  assert.equal(result.funded?.status, 'funded');
  assert.equal(result.failed, null);
});
