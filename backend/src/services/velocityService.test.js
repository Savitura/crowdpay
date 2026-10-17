const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  const calls = [];
  const wrapped = async (text, params) => {
    calls.push({ text, params });
    return queryImpl(text, params);
  };
  return {
    service: proxyquire('./velocityService', {
      '../config/database': { query: wrapped },
    }),
    calls,
  };
}

test('getCampaignVelocity computes hourly/daily/weekly velocity from recent contributions', async () => {
  const now = Date.now();
  const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
  const { service, calls } = buildService(async text => {
    if (text.includes('FROM campaigns c WHERE c.id')) {
      return {
        rows: [
          {
            id: 'c1',
            category: 'medical',
            target_amount: '1000',
            raised_amount: '150',
            deadline: null,
            velocity_alert_threshold: 10,
          },
        ],
      };
    }
    if (text.includes('FROM contributions')) {
      return { rows: [{ amount: '140', created_at: recent }] };
    }
    if (text.includes('cat_stats')) {
      return { rows: [{ category_avg_weekly: '70' }] };
    }
    return { rows: [] };
  });

  const result = await service.getCampaignVelocity('c1');

  assert.equal(calls.length, 3);
  assert.equal(result.velocity.amount_per_week, 140);
  assert.equal(result.velocity.amount_per_day, Math.round((140 / 7) * 100) / 100);
  assert.equal(result.category_comparison.category, 'medical');
  assert.equal(result.category_comparison.category_avg_weekly, 70);
  assert.equal(result.alerts.threshold, 10);
  assert.equal(result.trends.view_7d.length, 7);
  assert.equal(result.trends.view_30d.length, 30);
});

test('getCampaignVelocity throws when the campaign does not exist', async () => {
  const { service } = buildService(async () => ({ rows: [] }));
  await assert.rejects(() => service.getCampaignVelocity('missing'), /Campaign not found/);
});

test('updateCampaignVelocityAlertThreshold updates the column and returns the new threshold', async () => {
  const { service, calls } = buildService(async () => ({ rows: [] }));

  const result = await service.updateCampaignVelocityAlertThreshold('c1', 500);

  assert.deepEqual(result, { success: true, threshold: 500 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE campaigns SET velocity_alert_threshold/);
  assert.deepEqual(calls[0].params, [500, 'c1']);
});
