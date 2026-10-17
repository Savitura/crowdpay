const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('listCreatorCampaigns queries by creator_id', async () => {
  let sql = '';
  let params = null;
  const { listCreatorCampaigns } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text, p) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
        sql = text;
        params = p;
        return { rows: [{ id: 'camp-1', title: 'Mine', status: 'active' }] };
      },
    },
  });

  const res = await listCreatorCampaigns('user-1');
  assert.match(sql, /creator_id = \$1/);
  assert.match(sql, /contributor_count/);
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.deepEqual(params, ['user-1', 20, 0]);
  assert.equal(res.data[0].title, 'Mine');
});

test('listCreatorCampaigns fields param selects only requested columns and skips heavy joins', async () => {
  let sql = '';
  const { listCreatorCampaigns } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async (text, p) => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
        sql = text;
        return {
          rows: [{ id: 'camp-1', title: 'Mine', status: 'active', raised_amount: '10' }],
        };
      },
    },
  });

  const res = await listCreatorCampaigns('user-1', {
    fields: 'id,title,status,raised_amount',
    limit: 50,
  });

  assert.match(sql, /c\.id/);
  assert.match(sql, /c\.title/);
  assert.match(sql, /c\.status/);
  assert.match(sql, /c\.raised_amount/);
  assert.doesNotMatch(sql, /contributor_count/);
  assert.doesNotMatch(sql, /LEFT JOIN LATERAL/);
  assert.doesNotMatch(sql, /has_milestones/);
  assert.equal(res.data[0].id, 'camp-1');
  assert.equal(res.pagination.limit, 50);
});

test('listCreatorCampaigns ignores unknown fields and always includes id', async () => {
  let sql = '';
  const { listCreatorCampaigns } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async text => {
        if (text.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
        sql = text;
        return { rows: [] };
      },
    },
  });

  await listCreatorCampaigns('user-1', { fields: 'title,hack;DROP TABLE' });
  assert.match(sql, /c\.id/);
  assert.match(sql, /c\.title/);
  assert.doesNotMatch(sql, /DROP TABLE/);
  assert.doesNotMatch(sql, /LEFT JOIN LATERAL/);
});

test('listUserContributions includes conversion_rate', async () => {
  let contributionSql = '';
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async text => {
        if (text.includes('wallet_public_key FROM users')) {
          return { rows: [{ wallet_public_key: 'GUSER' }] };
        }
        contributionSql = text;
        return {
          rows: [
            {
              id: 'ctr-1',
              amount: '10',
              asset: 'USDC',
              conversion_rate: '0.25',
              campaign_title: 'Test',
            },
          ],
        };
      },
    },
  });

  const rows = await listUserContributions('user-1');
  assert.match(contributionSql, /conversion_rate/);
  assert.equal(rows[0].conversion_rate, '0.25');
});

test('listUserContributions returns null when user missing', async () => {
  const { listUserContributions } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async () => ({ rows: [] }),
    },
  });

  const rows = await listUserContributions('missing');
  assert.equal(rows, null);
});

// Badge criteria live in badgeService and are covered by badgeService.test.js;
// the dashboard only has to surface whatever that service returns.
function badgeServiceStub(
  badges = [{ id: 'first_contribution', label: 'First contribution', earned: true }]
) {
  return { evaluateBadges: async () => badges };
}

// Builds a mocked database whose query() routes by SQL text and records every
// milestone query it receives. `campaignCount` controls how many distinct
// campaigns the contributor has backed.
function buildDashboardDb(campaignCount) {
  const milestoneQueries = [];

  const contribs = Array.from({ length: campaignCount }, (_, i) => ({
    id: `ctr-${i}`,
    amount: '10',
    asset: 'USDC',
    tx_hash: `hash-${i}`,
    created_at: new Date().toISOString(),
    contract_refunded_at: null,
    contract_refund_tx_hash: null,
    campaign_id: i + 1,
    campaign_title: `Campaign ${i + 1}`,
    campaign_status: 'active',
    target_amount: '100',
    raised_amount: '50',
    asset_type: 'USDC',
    deadline: null,
    escrow_contract_id: `escrow-${i}`,
  }));

  const db = {
    query: async (text, params) => {
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GUSER' }] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: contribs };
      }
      if (text.includes('FROM milestones')) {
        milestoneQueries.push({ text, params });
        // One milestone per campaign, returned in a single result set.
        return {
          rows: contribs.map(c => ({
            id: `ms-${c.campaign_id}`,
            campaign_id: c.campaign_id,
            title: `Milestone ${c.campaign_id}`,
            release_percentage: '100',
            sort_order: 0,
            status: 'pending',
          })),
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  return { db, milestoneQueries };
}

test('getContributorDashboard batches milestones into a single query (no N+1)', async () => {
  const { db, milestoneQueries } = buildDashboardDb(100);
  const { getContributorDashboard } = proxyquire('./userDashboardService', {
    '../config/database': db,
    './badgeService': badgeServiceStub(),
  });

  const dashboard = await getContributorDashboard('user-1');

  // The whole point of the fix: one batched milestone query, never one per campaign.
  assert.equal(milestoneQueries.length, 1);
  assert.match(milestoneQueries[0].text, /campaign_id = ANY\(/);
  // Every backed campaign id is fetched in that single round-trip.
  assert.equal(milestoneQueries[0].params[0].length, 100);
  assert.equal(dashboard.campaigns.length, 100);
});

test('getContributorDashboard milestone query count is fixed regardless of campaign count', async () => {
  const small = buildDashboardDb(2);
  const large = buildDashboardDb(250);

  const { getContributorDashboard: dashSmall } = proxyquire('./userDashboardService', {
    '../config/database': small.db,
    './badgeService': badgeServiceStub(),
  });
  const { getContributorDashboard: dashLarge } = proxyquire('./userDashboardService', {
    '../config/database': large.db,
    './badgeService': badgeServiceStub(),
  });

  await dashSmall('user-1');
  await dashLarge('user-1');

  assert.equal(small.milestoneQueries.length, 1);
  assert.equal(large.milestoneQueries.length, 1);
});

test('getContributorDashboard maps batched milestones onto the right campaigns', async () => {
  const { db } = buildDashboardDb(3);
  const { getContributorDashboard } = proxyquire('./userDashboardService', {
    '../config/database': db,
    './badgeService': badgeServiceStub(),
  });

  const dashboard = await getContributorDashboard('user-1');

  for (const campaign of dashboard.campaigns) {
    assert.equal(campaign.milestones.length, 1);
    assert.equal(campaign.milestones[0].id, `ms-${campaign.campaign_id}`);
  }
});

test('getContributorDashboard returns empty shape when there are no contributions', async () => {
  const { getContributorDashboard } = proxyquire('./userDashboardService', {
    '../config/database': {
      query: async text => {
        if (text.includes('wallet_public_key FROM users')) {
          return { rows: [{ wallet_public_key: 'GUSER' }] };
        }
        return { rows: [] };
      },
    },
    './badgeService': badgeServiceStub([
      { id: 'first_contribution', label: 'First contribution', earned: false },
    ]),
  });

  const dashboard = await getContributorDashboard('user-1');
  assert.deepEqual(dashboard.campaigns, []);
  assert.equal(dashboard.stats.active_campaigns_backed, 0);
  assert.equal(dashboard.stats.campaigns_backed, 0);
  assert.equal(dashboard.stats.avg_contribution, 0);
  assert.ok(Array.isArray(dashboard.stats.badges));
  assert.equal(dashboard.stats.badges.find(b => b.id === 'first_contribution').earned, false);
});

test('getContributorDashboard computes campaigns_backed, avg_contribution, and badges', async () => {
  const { db } = buildDashboardDb(5);
  const { getContributorDashboard } = proxyquire('./userDashboardService', {
    '../config/database': db,
    './badgeService': badgeServiceStub([
      { id: 'first_contribution', label: 'First contribution', earned: true },
      { id: 'backed_5_campaigns', label: 'Backed 5 campaigns', earned: true },
      { id: 'backed_10_campaigns', label: 'Backed 10 campaigns', earned: false },
    ]),
  });

  const dashboard = await getContributorDashboard('user-1');

  assert.equal(dashboard.stats.campaigns_backed, 5);
  assert.equal(dashboard.stats.total_contributed, 50);
  assert.equal(dashboard.stats.avg_contribution, 10);
  assert.equal(dashboard.stats.badges.find(b => b.id === 'first_contribution').earned, true);
  assert.equal(dashboard.stats.badges.find(b => b.id === 'backed_5_campaigns').earned, true);
  assert.equal(dashboard.stats.badges.find(b => b.id === 'backed_10_campaigns').earned, false);
});

test('getContributorDashboardCsv builds a CSV with one row per contribution', async () => {
  const { db } = buildDashboardDb(2);
  const { getContributorDashboardCsv } = proxyquire('./userDashboardService', {
    '../config/database': db,
    './badgeService': badgeServiceStub(),
  });

  const csv = await getContributorDashboardCsv('user-1');
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'date,campaign,amount,asset,tx_hash,refund_status');
  assert.equal(lines.length, 3); // header + 2 contributions
  assert.match(lines[1], /Campaign 1/);
  assert.match(lines[1], /hash-0/);
});

test('getContributorDashboardCsv returns null for an unknown user', async () => {
  const { getContributorDashboardCsv } = proxyquire('./userDashboardService', {
    '../config/database': { query: async () => ({ rows: [] }) },
  });

  const csv = await getContributorDashboardCsv('missing');
  assert.equal(csv, null);
});
