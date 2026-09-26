const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { TtlCache } = require('../utils/TtlCache');

const MODULE_PATH = './analyticsService';

function rows(value) {
  return { rows: value };
}

function buildService(db) {
  return proxyquire(MODULE_PATH, {
    '../config/database': db,
    '../utils/TtlCache': { TtlCache },
  });
}

function countingDb(routes) {
  const calls = [];
  return {
    calls,
    db: {
      async query(text, params) {
        calls.push(text);
        for (const route of routes) {
          if (text.includes(route.match)) {
            return typeof route.result === 'function'
              ? route.result(text, params)
              : rows(route.result);
          }
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    },
  };
}

test.describe('analyticsService', () => {
  test('getPlatformAnalytics is cached between calls and invalidateCampaignAnalytics flushes it', async () => {
    const { db, calls } = countingDb([
      { match: 'LEFT JOIN contributions ctr ON ctr.campaign_id = c.id', result: [{ total_campaigns: 5, total_contributions: 100, unique_backers: 50, total_raised: '1000' }] },
      { match: 'ORDER BY raised_amount DESC', result: [{ id: 'c-1', title: 'Top', raised_amount: '500' }] },
      { match: "'24 hours'", result: [{ contributions_24h: 3, raised_24h: '30' }] },
      { match: 'GROUP BY asset', result: [{ asset: 'USDC', count: 3, total: '30' }] },
    ]);
    const svc = buildService(db);

    const first = await svc.getPlatformAnalytics();
    assert.equal(first.summary.total_campaigns, 5);
    assert.equal(calls.length, 4);

    const second = await svc.getPlatformAnalytics();
    assert.equal(second.summary.total_campaigns, 5);
    assert.equal(calls.length, 4, 'platform analytics should be served from cache');

    svc.invalidateCampaignAnalytics('c-1');
    await svc.getPlatformAnalytics();
    assert.equal(calls.length, 8, 'invalidating any campaign should flush the platform cache');
  });

  test('getPlatformAnalytics returns the summary shape', async () => {
    const { db } = countingDb([
      { match: 'LEFT JOIN contributions ctr ON ctr.campaign_id = c.id', result: [{ total_campaigns: 5, total_contributions: 100, unique_backers: 50, total_raised: '1000' }] },
      { match: 'ORDER BY raised_amount DESC', result: [{ id: 'c-1', title: 'Top', raised_amount: '500' }] },
      { match: "'24 hours'", result: [{ contributions_24h: 3, raised_24h: '30' }] },
      { match: 'GROUP BY asset', result: [{ asset: 'USDC', count: 3, total: '30' }] },
    ]);
    const svc = buildService(db);

    const result = await svc.getPlatformAnalytics();
    assert.equal(result.summary.total_campaigns, 5);
    assert.equal(result.top_campaigns.length, 1);
    assert.equal(result.recent_activity.contributions_24h, 3);
    assert.equal(result.asset_breakdown[0].asset, 'USDC');
  });

  test('getCampaignAnalytics returns null for an unknown campaign', async () => {
    const db = { query: async () => rows([]) };
    const svc = buildService(db);
    assert.equal(await svc.getCampaignAnalytics('missing'), null);
  });

  test('getCampaignAnalytics fills zero days across the campaign window', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const deadline = new Date('2026-01-03T00:00:00Z');
    const campaign = { created_at: created, deadline, raised_amount: '20', target_amount: '100', asset_type: 'USDC' };
    const { db } = countingDb([
      { match: 'FROM campaigns WHERE id = $1', result: [campaign] },
      { match: 'GROUP BY DATE(created_at)', result: [{ day: new Date('2026-01-01T00:00:00Z'), contribution_count: 2, total_amount: '20' }] },
      { match: 'is_recurring', result: [{ total_contributions: 2, unique_contributors: 1, avg_contribution: '10', recurring_contributions: 0, recurring_total: '0' }] },
      { match: 'GROUP BY currency', result: [{ currency: 'USDC', count: 2, total: '20' }] },
    ]);
    const svc = buildService(db);

    const result = await svc.getCampaignAnalytics('c-1');

    assert.equal(result.campaign.raised_amount, '20');
    assert.equal(result.summary.total_contributions, 2);
    assert.equal(result.daily_buckets.length, 3);
    assert.equal(result.daily_buckets[0].contribution_count, 2);
    assert.equal(result.daily_buckets[0].total_amount, '20');
    assert.deepEqual(result.daily_buckets[1], { day: '2026-01-02', contribution_count: 0, total_amount: '0' });
    assert.deepEqual(result.daily_buckets[2], { day: '2026-01-03', contribution_count: 0, total_amount: '0' });
    assert.equal(result.top_currencies[0].currency, 'USDC');
  });

  test('getCampaignContributors aggregates repeat and first-time counts', async () => {
    const { db } = countingDb([
      { match: 'times > 1', result: [{ repeat_contributors: 1, first_time_contributors: 2 }] },
      { match: 'LEFT JOIN users', result: [{ country: 'US', contributor_count: 2 }] },
    ]);
    const svc = buildService(db);

    const result = await svc.getCampaignContributors('c-1');
    assert.equal(result.repeat_contributors, 1);
    assert.equal(result.first_time_contributors, 2);
    assert.equal(result.country_breakdown[0].country, 'US');
  });

  test('getCampaignBackers returns totals, day series and repeat rate', async () => {
    const { db } = countingDb([
      { match: 'GROUP BY DATE(created_at)', result: [{ day: new Date('2026-01-01'), new_backers: 2 }] },
      { match: 'ORDER BY total_amount DESC', result: [{ sender_public_key: 'G1', contribution_count: 3, total_amount: '15' }] },
      { match: 'total_backers', result: [{ total_backers: 2 }] },
      { match: 'repeat_rate', result: [{ repeat_rate: '33.33' }] },
    ]);
    const svc = buildService(db);

    const result = await svc.getCampaignBackers('c-1');
    assert.equal(result.total_backers, 2);
    assert.equal(result.new_backers_by_day[0].new_backers, 2);
    assert.equal(result.top_backers[0].sender_public_key, 'G1');
    assert.equal(result.repeat_rate, 33.33);
  });

  test('getUserDashboardAnalytics runs all six dashboards queries', async () => {
    const { db, calls } = countingDb([
      { match: 'ORDER BY c.raised_amount DESC', result: [{ id: 'c-1', title: 'C', contribution_count: 1 }] },
      { match: "INTERVAL '60 days'", result: [{ campaign_id: 'c-1', title: 'C', day: new Date('2026-01-01'), daily_amount: '10' }] },
      { match: "INTERVAL '6 months'", result: [{ month: '2026-01', returning_count: 0, new_count: 1 }] },
      { match: 'FROM campaign_referrals', result: [{ referral_code: 'REF', click_count: 5, contribution_count: 1, conversion_rate: 20 }] },
      { match: "INTERVAL '30 days'", result: [{ day: new Date('2026-01-01'), contribution_count: 1, total_amount: '10' }] },
      { match: 'LEFT JOIN contributions ctr ON ctr.campaign_id = c.id', result: [{ total_campaigns: 2, total_raised: '50' }] },
    ]);
    const svc = buildService(db);

    const result = await svc.getUserDashboardAnalytics('creator-1');
    assert.equal(result.overview.total_campaigns, 2);
    assert.equal(result.recent_trend.length, 1);
    assert.equal(result.top_campaigns[0].id, 'c-1');
    assert.equal(result.funding_velocity[0].campaign_id, 'c-1');
    assert.equal(result.contributor_retention[0].month, '2026-01');
    assert.equal(result.referral_conversion[0].referral_code, 'REF');
    assert.equal(calls.length, 6);
  });
});