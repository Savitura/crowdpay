'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ queryImpl }) {
  return proxyquire('./campaignRecommendationService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../utils/pagination': {
      parsePagination: (options, defaults) => ({
        limit: options.limit !== undefined ? Math.min(options.limit, defaults.max) : defaults.limit,
      }),
    },
  });
}

test('upsertRecommendationsForUser returns empty array when userId is null', async () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  const result = await service.upsertRecommendationsForUser(null);
  assert.deepEqual(result, []);
});

test('upsertRecommendationsForUser returns empty array when userId is undefined', async () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  const result = await service.upsertRecommendationsForUser(undefined);
  assert.deepEqual(result, []);
});

test('upsertRecommendationsForUser returns empty array when user does not exist', async () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  const result = await service.upsertRecommendationsForUser('non-existent-user');
  assert.deepEqual(result, []);
});

test('upsertRecommendationsForUser returns empty array when no active campaigns exist', async () => {
  let callCount = 0;
  const service = buildService({
    queryImpl: async () => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: 'user-1' }] };
      if (callCount === 2) return { rowCount: 0 };
      if (callCount === 3) return { rows: [] };
      return { rows: [] };
    },
  });

  const result = await service.upsertRecommendationsForUser('user-1');
  assert.deepEqual(result, []);
});

test('upsertRecommendationsForUser assigns category-match reason with score 0.35', async () => {
  let callCount = 0;
  let insertedData;
  const service = buildService({
    queryImpl: async (sql, params) => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: 'user-1' }] };
      if (callCount === 2) return { rowCount: 0 };
      if (callCount === 3) {
        return {
          rows: [{ campaign_id: 'campaign-1', category: 'tech', asset_type: 'USDC' }],
        };
      }
      if (sql.includes('contributions') && sql.includes('DISTINCT')) return { rows: [] };
      if (sql.includes('campaign_followers')) {
        return { rows: [{ campaign_id: 'other-campaign' }] };
      }
      if (sql.includes('similar')) return { rows: [] };
      if (sql.includes('campaign_recommendation_dismissals')) return { rows: [] };
      if (sql.includes('c.category') && params && params[0] === 'tech') {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (sql.includes('INSERT INTO campaign_recommendations')) {
        insertedData = params;
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  });

  const result = await service.upsertRecommendationsForUser('user-1');
  assert.ok(result.length > 0);
  assert.ok(result[0].score >= 0.35);
  assert.ok(result[0].reasons.includes('category-match'));
});

test('upsertRecommendationsForUser assigns similar-contributors reason with dynamic score', async () => {
  let callCount = 0;
  const service = buildService({
    queryImpl: async (sql, params) => {
      callCount++;
      // User exists
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 'user-1' }] };
      // DELETE old recommendations
      if (sql.includes('DELETE FROM campaign_recommendations')) return { rowCount: 0 };
      // All campaigns
      if (sql.includes('FROM campaigns c') && sql.includes('c.deleted_at IS NULL') && !sql.includes('JOIN')) {
        return {
          rows: [{ campaign_id: 'campaign-1', category: 'tech', asset_type: 'USDC' }],
        };
      }
      // User contributed campaigns
      if (sql.includes('SELECT DISTINCT ctr.campaign_id') && sql.includes('contributions ctr'))
        return { rows: [] };
      // User followed campaigns
      if (sql.includes('FROM campaign_followers')) return { rows: [] };
      // Similar users
      if (sql.includes('SELECT DISTINCT u.id AS user_id') && sql.includes('u.id <> $1')) {
        return { rows: [{ user_id: 'similar-user-1' }, { user_id: 'similar-user-2' }] };
      }
      // Dismissed campaigns
      if (sql.includes('campaign_recommendation_dismissals')) return { rows: [] };
      // Category match check
      if (sql.includes('c.category = $1')) return { rows: [] };
      // Similar user contributions count
      if (sql.includes('COUNT(*)::int AS count') && sql.includes('ANY($1::uuid[])')) {
        return { rows: [{ count: 3 }] };
      }
      // INSERT recommendations
      if (sql.includes('INSERT INTO campaign_recommendations')) return { rowCount: 1 };
      return { rows: [] };
    },
  });

  const result = await service.upsertRecommendationsForUser('user-1');
  assert.ok(result.length > 0, 'Should have recommendations');
  // Score should include similar-contributors (3 * 0.2 = 0.6) + asset-fit (0.1) = 0.7
  assert.ok(result[0].score >= 0.6);
  assert.ok(result[0].reasons.includes('similar-contributors'));
});

test('upsertRecommendationsForUser assigns asset-fit reason for USDC campaigns', async () => {
  const service = buildService({
    queryImpl: async (sql, params) => {
      // User exists
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 'user-1' }] };
      // DELETE old recommendations
      if (sql.includes('DELETE FROM campaign_recommendations')) return { rowCount: 0 };
      // All campaigns
      if (sql.includes('FROM campaigns c') && sql.includes('c.deleted_at IS NULL') && !sql.includes('JOIN')) {
        return {
          rows: [{ campaign_id: 'campaign-1', category: 'tech', asset_type: 'USDC' }],
        };
      }
      // User contributed campaigns
      if (sql.includes('SELECT DISTINCT ctr.campaign_id')) return { rows: [] };
      // User followed campaigns - return one to enable category matching
      if (sql.includes('FROM campaign_followers') && sql.includes('WHERE user_id')) {
        return { rows: [{ campaign_id: 'other-campaign' }] };
      }
      // Similar users
      if (sql.includes('SELECT DISTINCT u.id AS user_id')) return { rows: [] };
      // Dismissed campaigns
      if (sql.includes('campaign_recommendation_dismissals')) return { rows: [] };
      // Category match check - return a match so we get above 0.3 threshold
      if (sql.includes('c.category = $1')) return { rows: [{ id: 'campaign-1' }] };
      // INSERT recommendations
      if (sql.includes('INSERT INTO campaign_recommendations')) return { rowCount: 1 };
      return { rows: [] };
    },
  });

  const result = await service.upsertRecommendationsForUser('user-1');
  assert.ok(result.length > 0, 'Should have recommendations');
  // Score should be 0.35 (category-match) + 0.1 (asset-fit) = 0.45
  assert.ok(result[0].reasons.includes('asset-fit'), 'Should include asset-fit reason');
  assert.ok(result[0].reasons.includes('category-match'), 'Should also include category-match');
});

test('upsertRecommendationsForUser only recommends campaigns with score >= 0.3', async () => {
  let callCount = 0;
  const service = buildService({
    queryImpl: async sql => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: 'user-1' }] };
      if (callCount === 2) return { rowCount: 0 };
      if (callCount === 3) {
        return {
          rows: [{ campaign_id: 'campaign-low-score', category: 'tech', asset_type: 'XLM' }],
        };
      }
      if (sql.includes('INSERT INTO campaign_recommendations')) return { rowCount: 1 };
      return { rows: [] };
    },
  });

  const result = await service.upsertRecommendationsForUser('user-1');
  // No matching criteria means score < 0.3 (only XLM, no category match, no similar contributors)
  assert.equal(result.length, 0);
});

test('upsertRecommendationsForUser inserts recommendations with correct format', async () => {
  let insertCall;
  let callCount = 0;
  const service = buildService({
    queryImpl: async (sql, params) => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: 'user-1' }] };
      if (callCount === 2) return { rowCount: 0 };
      if (callCount === 3) {
        return {
          rows: [{ campaign_id: 'campaign-1', category: 'tech', asset_type: 'USDC' }],
        };
      }
      if (sql.includes('campaign_followers')) return { rows: [{ campaign_id: 'other' }] };
      if (sql.includes('c.category')) return { rows: [{ id: 'campaign-1' }] };
      if (sql.includes('similar')) return { rows: [] };
      if (sql.includes('campaign_recommendation_dismissals')) return { rows: [] };
      if (sql.includes('INSERT INTO campaign_recommendations')) {
        insertCall = { sql, params };
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  });

  const result = await service.upsertRecommendationsForUser('user-1');
  assert.ok(insertCall);
  assert.ok(insertCall.sql.includes('user_id, campaign_id, score, reasons'));
  assert.ok(Array.isArray(insertCall.params));
  assert.equal(insertCall.params.length, 4);
});

test('getRecommendedCampaigns returns empty array for null userId', async () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  const result = await service.getRecommendedCampaigns(null);
  assert.deepEqual(result, []);
});

test('getRecommendedCampaigns returns empty array for undefined userId', async () => {
  const service = buildService({ queryImpl: async () => ({ rows: [] }) });
  const result = await service.getRecommendedCampaigns(undefined);
  assert.deepEqual(result, []);
});

test('getRecommendedCampaigns returns recommended campaigns with full details', async () => {
  let callCount = 0;
  const service = buildService({
    queryImpl: async sql => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: 'user-1' }] };
      if (callCount === 2) return { rowCount: 0 };
      if (callCount === 3) return { rows: [] };
      if (sql.includes('FROM campaign_recommendations cr')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Test Campaign',
              description: 'Description',
              target_amount: '10000',
              raised_amount: '5000',
              asset_type: 'USDC',
              creator_name: 'Alice',
              score: 0.75,
              reasons: ['category-match', 'asset-fit'],
              backer_count: 10,
              progress_pct: 50.0,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await service.getRecommendedCampaigns('user-1');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'campaign-1');
  assert.equal(result[0].title, 'Test Campaign');
  assert.equal(result[0].creator_name, 'Alice');
  assert.equal(result[0].score, 0.75);
});

test('getRecommendedCampaigns falls back to general campaigns when no recommendations exist', async () => {
  let callCount = 0;
  const service = buildService({
    queryImpl: async sql => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: 'user-1' }] };
      if (callCount === 2) return { rowCount: 0 };
      if (callCount === 3) return { rows: [] };
      if (sql.includes('FROM campaign_recommendations cr')) return { rows: [] };
      if (sql.includes('FROM campaigns c') && sql.includes('c.id NOT IN')) {
        return {
          rows: [
            {
              id: 'fallback-campaign',
              title: 'Fallback Campaign',
              creator_name: 'Bob',
              backer_count: 5,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await service.getRecommendedCampaigns('user-1');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'fallback-campaign');
});

test('getRecommendedCampaigns filters out deleted, hidden, and duplicate campaigns', async () => {
  let recommendationsQuery;
  const service = buildService({
    queryImpl: async sql => {
      if (sql.includes('FROM campaign_recommendations cr')) {
        recommendationsQuery = sql;
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 'user-1' }] };
      return { rows: [] };
    },
  });

  await service.getRecommendedCampaigns('user-1');
  assert.ok(recommendationsQuery);
  assert.ok(recommendationsQuery.includes('c.deleted_at IS NULL'));
  assert.ok(recommendationsQuery.includes('c.is_hidden = FALSE'));
  assert.ok(recommendationsQuery.includes('c.is_flagged_duplicate = FALSE'));
  assert.ok(recommendationsQuery.includes("c.status = 'active'"));
});

test('getRecommendedCampaigns returns empty array on error', async () => {
  const service = buildService({
    queryImpl: async () => {
      throw new Error('Database error');
    },
  });

  const result = await service.getRecommendedCampaigns('user-1');
  assert.deepEqual(result, []);
});
