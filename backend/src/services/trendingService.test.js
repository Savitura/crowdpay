'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ queryImpl }) {
  return proxyquire('./trendingService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  });
}

test('deadlineScore returns 0 for null deadline', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  assert.equal(service.deadlineScore(null), 0);
});

test('deadlineScore returns 0 for undefined deadline', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  assert.equal(service.deadlineScore(undefined), 0);
});

test('deadlineScore returns 0 for negative days (already ended)', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  assert.equal(service.deadlineScore(-1), 0);
  assert.equal(service.deadlineScore(-10), 0);
});

test('deadlineScore returns 1.0 for 1-7 days remaining (urgency boost)', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  assert.equal(service.deadlineScore(1), 1);
  assert.equal(service.deadlineScore(3), 1);
  assert.equal(service.deadlineScore(7), 1);
});

test('deadlineScore returns 0 for >30 days remaining', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  assert.equal(service.deadlineScore(31), 0);
  assert.equal(service.deadlineScore(100), 0);
});

test('deadlineScore returns linear taper between 7 and 30 days', () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  const score8 = service.deadlineScore(8);
  const score15 = service.deadlineScore(15);
  const score29 = service.deadlineScore(29);

  assert.ok(score8 > score15);
  assert.ok(score15 > score29);
  assert.ok(score8 < 1);
  assert.ok(score29 > 0);

  // Verify calculation for day 15 (midpoint between 7 and 30)
  const expected15 = 1 - (15 - 7) / (30 - 7);
  assert.ok(Math.abs(score15 - expected15) < 0.001);
});

test('recomputeTrendingScores returns {updated: 0} when no active campaigns exist', async () => {
  const service = buildService({
    queryImpl: async () => ({ rows: [] }),
  });

  const result = await service.recomputeTrendingScores();
  assert.deepEqual(result, { updated: 0 });
});

test('recomputeTrendingScores computes and updates trending scores for active campaigns', async () => {
  const mockCampaigns = [
    {
      id: 'campaign-1',
      raised_amount: '5000',
      target_amount: '10000',
      deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      contributions_last_24h: 10,
      unique_contributors_last_7d: 20,
    },
    {
      id: 'campaign-2',
      raised_amount: '8000',
      target_amount: '10000',
      deadline: new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString(),
      contributions_last_24h: 5,
      unique_contributors_last_7d: 10,
    },
  ];

  let callCount = 0;
  const service = buildService({
    queryImpl: async sql => {
      callCount++;
      if (callCount === 1) {
        return { rows: mockCampaigns };
      }
      return { rowCount: 2 };
    },
  });

  const result = await service.recomputeTrendingScores();
  assert.equal(result.updated, 2);
  assert.equal(callCount, 2);
});

test('recomputeTrendingScores calculates higher scores for campaigns with urgency', async () => {
  const urgentCampaign = {
    id: 'urgent-campaign',
    raised_amount: '5000',
    target_amount: '10000',
    deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    contributions_last_24h: 10,
    unique_contributors_last_7d: 10,
  };

  const farCampaign = {
    id: 'far-campaign',
    raised_amount: '5000',
    target_amount: '10000',
    deadline: new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString(),
    contributions_last_24h: 10,
    unique_contributors_last_7d: 10,
  };

  let callCount = 0;
  let urgentScore, farScore;

  const service = buildService({
    queryImpl: async (sql, params) => {
      callCount++;
      if (callCount === 1) {
        return { rows: [urgentCampaign, farCampaign] };
      }
      if (sql.includes('UPDATE campaigns') && params) {
        urgentScore = parseFloat(params[3]);
        farScore = parseFloat(params[7]);
      }
      return { rowCount: 2 };
    },
  });

  await service.recomputeTrendingScores();
  assert.ok(urgentScore > farScore, `Urgent score (${urgentScore}) should be > far score (${farScore})`);
});

test('recomputeTrendingScores handles campaigns with no deadline', async () => {
  const mockCampaign = {
    id: 'no-deadline',
    raised_amount: '5000',
    target_amount: '10000',
    deadline: null,
    contributions_last_24h: 10,
    unique_contributors_last_7d: 10,
  };

  const service = buildService({
    queryImpl: async sql => {
      if (sql.includes('SELECT')) {
        return { rows: [mockCampaign] };
      }
      return { rowCount: 1 };
    },
  });

  const result = await service.recomputeTrendingScores();
  assert.equal(result.updated, 1);
});

test('recomputeTrendingScores calculates score using correct formula weights', async () => {
  const mockCampaign = {
    id: 'test-campaign',
    raised_amount: '5000',
    target_amount: '10000',
    deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    contributions_last_24h: 10,
    unique_contributors_last_7d: 20,
  };

  let computedScore;
  const service = buildService({
    queryImpl: async (sql, params) => {
      if (sql.includes('SELECT')) {
        return { rows: [mockCampaign] };
      }
      if (sql.includes('UPDATE') && params) {
        computedScore = parseFloat(params[3]);
      }
      return { rowCount: 1 };
    },
  });

  await service.recomputeTrendingScores();
  // Expected: (10/10 * 40) + (0.5 * 30) + (20/20 * 20) + (1.0 * 10) = 85
  assert.ok(Math.abs(computedScore - 85) < 0.01, `Expected ~85, got ${computedScore}`);
});

test('getTrendingCampaigns returns empty array when no campaigns exist', async () => {
  const service = buildService({
    queryImpl: async () => ({ rows: [] }),
  });

  const result = await service.getTrendingCampaigns();
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test('getTrendingCampaigns returns top campaigns ordered by trending_score', async () => {
  const mockCampaigns = [
    { id: 'campaign-1', title: 'Top Campaign', trending_score: '95.5', creator_name: 'Alice' },
    { id: 'campaign-2', title: 'Second Campaign', trending_score: '80.2', creator_name: 'Bob' },
  ];

  const service = buildService({
    queryImpl: async () => ({ rows: mockCampaigns }),
  });

  const result = await service.getTrendingCampaigns();
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'campaign-1');
  assert.equal(result[1].id, 'campaign-2');
});

test('getTrendingCampaigns respects limit parameter with default of 20', async () => {
  const mockCampaigns = Array.from({ length: 30 }, (_, i) => ({
    id: `campaign-${i}`,
    title: `Campaign ${i}`,
    trending_score: `${90 - i}`,
    creator_name: 'Creator',
  }));

  const service = buildService({
    queryImpl: async () => ({ rows: mockCampaigns }),
  });

  const result = await service.getTrendingCampaigns();
  assert.equal(result.length, 20);
});

test('getTrendingCampaigns respects custom limit parameter', async () => {
  const mockCampaigns = Array.from({ length: 50 }, (_, i) => ({
    id: `campaign-${i}`,
    title: `Campaign ${i}`,
    trending_score: `${90 - i}`,
  }));

  const service = buildService({
    queryImpl: async () => ({ rows: mockCampaigns }),
  });

  const result = await service.getTrendingCampaigns({ limit: 10 });
  assert.equal(result.length, 10);
});

test('getTrendingCampaigns caps limit at 50 maximum', async () => {
  const mockCampaigns = Array.from({ length: 100 }, (_, i) => ({
    id: `campaign-${i}`,
    title: `Campaign ${i}`,
    trending_score: `${100 - i}`,
  }));

  const service = buildService({
    queryImpl: async () => ({ rows: mockCampaigns }),
  });

  const result = await service.getTrendingCampaigns({ limit: 100 });
  assert.equal(result.length, 50);
});

test('getTrendingCampaigns enforces minimum limit of 1', async () => {
  const mockCampaigns = [
    { id: 'campaign-1', title: 'Campaign 1', trending_score: '95' },
    { id: 'campaign-2', title: 'Campaign 2', trending_score: '90' },
  ];

  const service = buildService({
    queryImpl: async () => ({ rows: mockCampaigns }),
  });

  const result = await service.getTrendingCampaigns({ limit: 0 });
  // The service limits to minimum of 1, but still returns what the cache provides sliced
  assert.ok(result.length >= 1, `Expected at least 1 result, got ${result.length}`);
});

test('getTrendingCampaigns filters out hidden, deleted, and duplicate campaigns', async () => {
  let capturedQuery;
  const service = buildService({
    queryImpl: async sql => {
      capturedQuery = sql;
      return { rows: [{ id: 'campaign-1', title: 'Active Campaign', trending_score: '95' }] };
    },
  });

  await service.getTrendingCampaigns();
  assert.ok(capturedQuery.includes('c.deleted_at IS NULL'));
  assert.ok(capturedQuery.includes('c.is_hidden = FALSE'));
  assert.ok(capturedQuery.includes('c.is_flagged_duplicate = FALSE'));
  assert.ok(capturedQuery.includes("c.status = 'active'"));
});

test('getTrendingCampaigns includes creator name in results', async () => {
  let capturedQuery;
  const service = buildService({
    queryImpl: async sql => {
      capturedQuery = sql;
      return {
        rows: [
          {
            id: 'campaign-1',
            title: 'Test Campaign',
            trending_score: '95',
            creator_name: 'John Doe',
          },
        ],
      };
    },
  });

  const result = await service.getTrendingCampaigns();
  assert.equal(result[0].creator_name, 'John Doe');
  assert.ok(capturedQuery.includes('JOIN users u ON u.id = c.creator_id'));
});

