'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function createDashboardService({ dbQueryHandler, badgesHandler } = {}) {
  const queryCalls = [];
  const dbMock = {
    async query(sql, params) {
      queryCalls.push({ sql, params });
      if (dbQueryHandler) {
        return dbQueryHandler(sql, params, queryCalls.length);
      }
      return { rows: [] };
    },
  };

  const badgeMock = {
    async evaluateBadges(userId) {
      if (badgesHandler) {
        return badgesHandler(userId);
      }
      return [{ id: 'badge-1', name: 'First Backer' }];
    },
  };

  const service = proxyquire('./userDashboardService', {
    '../config/database': dbMock,
    './badgeService': badgeMock,
  });

  return { service, queryCalls };
}

test('userDashboardService - listCreatorCampaigns returns paginated campaigns with default fields', async () => {
  const mockCampaigns = [
    {
      id: 1,
      title: 'Campaign 1',
      status: 'active',
      asset_type: 'native',
      target_amount: '1000',
      raised_amount: '200',
      deadline: '2026-12-31T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      is_hidden: false,
      contributor_count: 5,
      has_milestones: true,
    },
  ];

  const { service, queryCalls } = createDashboardService({
    dbQueryHandler: async sql => {
      if (sql.includes('COUNT(*)::int AS total')) {
        return { rows: [{ total: 42 }] };
      }
      return { rows: mockCampaigns };
    },
  });

  const result = await service.listCreatorCampaigns('user-creator-1', { page: '1', limit: '20' });

  assert.equal(queryCalls.length, 2);
  // Count query
  assert.equal(queryCalls[0].params[0], 'user-creator-1');
  // List query
  assert.equal(queryCalls[1].params[0], 'user-creator-1');
  assert.equal(queryCalls[1].params[1], 20); // limit
  assert.equal(queryCalls[1].params[2], 0); // offset

  assert.deepEqual(result.data, mockCampaigns);
  assert.deepEqual(result.pagination, {
    page: 1,
    limit: 20,
    total: 42,
    totalPages: 3,
  });
});

test('userDashboardService - listCreatorCampaigns handles custom pagination clamps and field filtering', async () => {
  let selectQuerySql = '';
  const { service } = createDashboardService({
    dbQueryHandler: async sql => {
      if (sql.includes('COUNT(*)::int AS total')) {
        return { rows: [{ total: 10 }] };
      }
      selectQuerySql = sql;
      return { rows: [{ id: 10, title: 'Mini Camp' }] };
    },
  });

  // Test pagination clamps: page -5 -> 1, limit 500 -> 100
  // Test fields: requested only 'title', should automatically prepend 'id' and skip contributor_count LATERAL JOIN
  const result = await service.listCreatorCampaigns('user-1', {
    page: -5,
    limit: 500,
    fields: 'title,unknown_field',
  });

  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.limit, 100);
  assert.equal(result.pagination.totalPages, 1);

  // Field selection should only select c.id and c.title
  assert.match(selectQuerySql, /SELECT c\.id,\s+c\.title/);
  // Should NOT have LATERAL JOIN stats because contributor_count is not in selected fields
  assert.equal(selectQuerySql.includes('LEFT JOIN LATERAL'), false);
});

test('userDashboardService - listCreatorCampaigns includes LATERAL JOIN when contributor_count is requested', async () => {
  let selectQuerySql = '';
  const { service } = createDashboardService({
    dbQueryHandler: async sql => {
      if (sql.includes('COUNT(*)::int AS total')) {
        return { rows: [{ total: 1 }] };
      }
      selectQuerySql = sql;
      return { rows: [] };
    },
  });

  await service.listCreatorCampaigns('user-1', {
    fields: 'contributor_count,raised_amount',
  });

  assert.match(selectQuerySql, /LEFT JOIN LATERAL/);
  assert.match(selectQuerySql, /COALESCE\(stats\.contributor_count, 0\) AS contributor_count/);
});

test('userDashboardService - listUserContributions returns null when user is not found', async () => {
  const { service, queryCalls } = createDashboardService({
    dbQueryHandler: async () => ({ rows: [] }),
  });

  const res = await service.listUserContributions('non-existent-user');
  assert.equal(res, null);
  assert.equal(queryCalls.length, 1);
});

test('userDashboardService - listUserContributions returns contributions and caches result', async () => {
  const mockContributions = [
    {
      id: 'ctr-1',
      amount: '50',
      asset: 'USDC',
      campaign_id: 101,
      campaign_title: 'Save the Ocean',
    },
  ];

  let dbCount = 0;
  const { service } = createDashboardService({
    dbQueryHandler: async sql => {
      dbCount++;
      if (sql.includes('SELECT wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'G_WALLET_USER1' }] };
      }
      return { rows: mockContributions };
    },
  });

  // First call: hits DB
  const res1 = await service.listUserContributions('user-cached-1');
  assert.deepEqual(res1, mockContributions);
  assert.equal(dbCount, 2);

  // Second call: served from cache, no DB queries
  const res2 = await service.listUserContributions('user-cached-1');
  assert.deepEqual(res2, mockContributions);
  assert.equal(dbCount, 2);

  // Invalidate cache
  service.invalidateUserDashboard('user-cached-1');

  // Third call after invalidation: hits DB again
  const res3 = await service.listUserContributions('user-cached-1');
  assert.deepEqual(res3, mockContributions);
  assert.equal(dbCount, 4);
});

test('userDashboardService - getContributorDashboard returns null when user does not exist', async () => {
  const { service } = createDashboardService({
    dbQueryHandler: async () => ({ rows: [] }),
  });

  const dashboard = await service.getContributorDashboard('ghost-user');
  assert.equal(dashboard, null);
});

test('userDashboardService - getContributorDashboard returns empty stats when user has no contributions', async () => {
  let badgeEvaluatedUser = null;
  const { service } = createDashboardService({
    dbQueryHandler: async sql => {
      if (sql.includes('SELECT wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'G_EMPTY_USER' }] };
      }
      // Contributions query returns empty array
      return { rows: [] };
    },
    badgesHandler: async userId => {
      badgeEvaluatedUser = userId;
      return [];
    },
  });

  const dashboard = await service.getContributorDashboard('user-no-contribs');

  assert.equal(badgeEvaluatedUser, 'user-no-contribs');
  assert.deepEqual(dashboard.campaigns, []);
  assert.deepEqual(dashboard.stats, {
    total_contributed: 0,
    active_campaigns_backed: 0,
    total_refunded: 0,
    campaigns_backed: 0,
    campaigns_completed: 0,
    avg_contribution: 0,
    badges: [],
  });
});

test('userDashboardService - getContributorDashboard computes aggregations, refunds, and milestones correctly', async () => {
  const mockContribRows = [
    // Contribution 1: to Campaign 1 (active), not refunded
    {
      id: 'ctr-1',
      amount: '100',
      asset: 'USDC',
      tx_hash: 'tx_111',
      created_at: '2026-01-01T00:00:00Z',
      contract_refunded_at: null,
      contract_refund_tx_hash: null,
      campaign_id: 1,
      campaign_title: 'Campaign One',
      campaign_status: 'active',
      target_amount: '1000',
      raised_amount: '500',
      asset_type: 'USDC',
      deadline: '2026-12-31T00:00:00Z',
      escrow_contract_id: 'C_ESCROW_1',
    },
    // Contribution 2: also to Campaign 1 (active), not refunded
    {
      id: 'ctr-2',
      amount: '50',
      asset: 'USDC',
      tx_hash: 'tx_222',
      created_at: '2026-01-02T00:00:00Z',
      contract_refunded_at: null,
      contract_refund_tx_hash: null,
      campaign_id: 1,
      campaign_title: 'Campaign One',
      campaign_status: 'active',
      target_amount: '1000',
      raised_amount: '500',
      asset_type: 'USDC',
      deadline: '2026-12-31T00:00:00Z',
      escrow_contract_id: 'C_ESCROW_1',
    },
    // Contribution 3: to Campaign 2 (completed), refunded
    {
      id: 'ctr-3',
      amount: '200',
      asset: 'XLM',
      tx_hash: 'tx_333',
      created_at: '2026-02-01T00:00:00Z',
      contract_refunded_at: '2026-02-10T00:00:00Z',
      contract_refund_tx_hash: 'tx_ref_333',
      campaign_id: 2,
      campaign_title: 'Campaign Two',
      campaign_status: 'completed',
      target_amount: '5000',
      raised_amount: '6000',
      asset_type: 'native',
      deadline: '2026-02-05T00:00:00Z',
      escrow_contract_id: 'C_ESCROW_2',
    },
    // Contribution 4: to Campaign 3 (failed), refund pending
    {
      id: 'ctr-4',
      amount: '50',
      asset: 'USDC',
      tx_hash: 'tx_444',
      created_at: '2026-03-01T00:00:00Z',
      contract_refunded_at: null,
      contract_refund_tx_hash: null,
      campaign_id: 3,
      campaign_title: 'Campaign Three',
      campaign_status: 'failed',
      target_amount: '2000',
      raised_amount: '100',
      asset_type: 'USDC',
      deadline: '2026-03-05T00:00:00Z',
      escrow_contract_id: 'C_ESCROW_3',
    },
  ];

  const mockMilestones = [
    {
      id: 10,
      campaign_id: 1,
      title: 'Milestone 1',
      release_percentage: '30.00',
      sort_order: 1,
      status: 'released',
    },
    {
      id: 11,
      campaign_id: 1,
      title: 'Milestone 2',
      release_percentage: '70.00',
      sort_order: 2,
      status: 'pending',
    },
  ];

  const { service } = createDashboardService({
    dbQueryHandler: async sql => {
      if (sql.includes('SELECT wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'G_ACTIVE_BACKER' }] };
      }
      if (sql.includes('FROM milestones')) {
        return { rows: mockMilestones };
      }
      return { rows: mockContribRows };
    },
    badgesHandler: async () => [{ id: 'super-backer' }],
  });

  const dashboard = await service.getContributorDashboard('user-backer-1');

  // Total contributed = 100 + 50 + 200 + 50 = 400
  // Total refunded = 200 (only ctr-3 has contract_refunded_at)
  // Avg contribution = 400 / 4 = 100
  // Campaigns backed = 3 unique campaigns (1, 2, 3)
  // Active campaigns backed: campaign 1 (active) = 1
  // Campaigns completed: campaign 2 (completed) = 1
  assert.equal(dashboard.stats.total_contributed, 400);
  assert.equal(dashboard.stats.total_refunded, 200);
  assert.equal(dashboard.stats.avg_contribution, 100);
  assert.equal(dashboard.stats.campaigns_backed, 3);
  assert.equal(dashboard.stats.active_campaigns_backed, 1);
  assert.equal(dashboard.stats.campaigns_completed, 1);
  assert.deepEqual(dashboard.stats.badges, [{ id: 'super-backer' }]);

  // Verify Campaigns list
  assert.equal(dashboard.campaigns.length, 3);

  // Campaign 1: aggregated 2 contributions
  const camp1 = dashboard.campaigns.find(c => c.campaign_id === 1);
  assert.equal(camp1.contributed_amount, 150);
  assert.equal(camp1.contributions.length, 2);
  assert.equal(camp1.milestones.length, 2);
  assert.equal(camp1.milestones[0].release_percentage, 30);
  assert.equal(camp1.contributions[0].refund_status, null);

  // Campaign 2: refunded contribution
  const camp2 = dashboard.campaigns.find(c => c.campaign_id === 2);
  assert.equal(camp2.contributions[0].refund_status, 'processed');
  assert.equal(camp2.contributions[0].refund_tx_hash, 'tx_ref_333');

  // Campaign 3: failed campaign, pending refund
  const camp3 = dashboard.campaigns.find(c => c.campaign_id === 3);
  assert.equal(camp3.contributions[0].refund_status, 'pending');
});

test('userDashboardService - getContributorDashboardCsv outputs properly escaped CSV string', async () => {
  const mockContribRows = [
    {
      id: 'ctr-csv-1',
      amount: '75',
      asset: 'USDC',
      tx_hash: 'tx_csv_1',
      created_at: '2026-05-01T12:00:00Z',
      contract_refunded_at: null,
      contract_refund_tx_hash: null,
      campaign_id: 10,
      campaign_title: 'Campaign with, comma and "quotes"',
      campaign_status: 'active',
      target_amount: '1000',
      raised_amount: '200',
      asset_type: 'USDC',
      deadline: '2026-12-31T00:00:00Z',
      escrow_contract_id: null,
    },
  ];

  const { service } = createDashboardService({
    dbQueryHandler: async sql => {
      if (sql.includes('SELECT wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'G_CSV_USER' }] };
      }
      if (sql.includes('FROM milestones')) {
        return { rows: [] };
      }
      return { rows: mockContribRows };
    },
  });

  const csv = await service.getContributorDashboardCsv('user-csv');

  assert.ok(csv.startsWith('date,campaign,amount,asset,tx_hash,refund_status\n'));
  // Title "Campaign with, comma and "quotes"" should be escaped to ""Campaign with, comma and ""quotes""""
  assert.match(csv, /"Campaign with, comma and ""quotes"""/);
  assert.match(csv, /75,USDC,tx_csv_1/);
});

test('userDashboardService - getContributorDashboardCsv returns null when user does not exist', async () => {
  const { service } = createDashboardService({
    dbQueryHandler: async () => ({ rows: [] }),
  });

  const csv = await service.getContributorDashboardCsv('non-existent');
  assert.equal(csv, null);
});
