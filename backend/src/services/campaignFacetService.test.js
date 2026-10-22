const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const cache = require('../utils/cache');
const {
  computeCampaignFacets,
  getCampaignFacets,
  getCategoryFacets,
  getCountryFacets,
  invalidateCampaignFacets,
  FACETS_CACHE_KEY,
  CATEGORY_FACETS_CACHE_KEY,
  COUNTRY_FACETS_CACHE_KEY,
} = require('./campaignFacetService');

// Helper to reset shared cache before/after each test
function resetCache() {
  cache.clear();
}

test.beforeEach(resetCache);
test.afterEach(resetCache);

test('computeCampaignFacets executes expected queries with active public campaign filters', async () => {
  const executedQueries = [];
  const mockClient = {
    query: async (sql, _params) => {
      executedQueries.push(sql);
      if (sql.includes('GROUP BY category')) {
        return {
          rows: [
            { category: 'environment', count: 12 },
            { category: 'education', count: 8 },
          ],
        };
      }
      if (sql.includes('GROUP BY asset_type')) {
        return {
          rows: [
            { asset_type: 'USDC', count: 15 },
            { asset_type: 'XLM', count: 5 },
          ],
        };
      }
      if (sql.includes('GROUP BY country')) {
        return {
          rows: [
            { country: 'NG', count: 9 },
            { country: 'US', count: 7 },
          ],
        };
      }
      if (sql.includes('MIN(raised_amount)')) {
        return { rows: [{ min_funding: '50.00', max_funding: '5000.00' }] };
      }
      if (sql.includes("kyc_status = 'verified'")) {
        return { rows: [{ count: 14 }] };
      }
      return { rows: [] };
    },
  };

  const facets = await computeCampaignFacets(mockClient);

  assert.equal(executedQueries.length, 5);
  for (const query of executedQueries) {
    assert.match(query, /c\.deleted_at IS NULL/);
    assert.match(query, /c\.is_flagged_duplicate = FALSE/);
    assert.match(query, /c\.is_hidden = FALSE/);
    assert.match(query, /c\.status = 'active'/);
  }

  assert.deepEqual(facets.categories, [
    { category: 'environment', count: 12 },
    { category: 'education', count: 8 },
  ]);
  assert.deepEqual(facets.assets, [
    { asset_type: 'USDC', count: 15 },
    { asset_type: 'XLM', count: 5 },
  ]);
  assert.deepEqual(facets.countries, [
    { country: 'NG', count: 9 },
    { country: 'US', count: 7 },
  ]);
  assert.deepEqual(facets.funding, { min: 50, max: 5000 });
  assert.equal(facets.verified_creators, 14);
});

test('computeCampaignFacets safely handles empty query results', async () => {
  const mockClient = {
    query: async () => ({ rows: [] }),
  };

  const facets = await computeCampaignFacets(mockClient);

  assert.deepEqual(facets.categories, []);
  assert.deepEqual(facets.assets, []);
  assert.deepEqual(facets.countries, []);
  assert.deepEqual(facets.funding, { min: 0, max: 0 });
  assert.equal(facets.verified_creators, 0);
});

test('getCampaignFacets caches results on cache miss and serves from cache on subsequent calls', async () => {
  let dbCallCount = 0;
  const mockClient = {
    query: async sql => {
      dbCallCount++;
      if (sql.includes('GROUP BY category')) {
        return { rows: [{ category: 'tech', count: 4 }] };
      }
      if (sql.includes('GROUP BY asset_type')) {
        return { rows: [{ asset_type: 'USDC', count: 4 }] };
      }
      if (sql.includes('GROUP BY country')) {
        return { rows: [{ country: 'GB', count: 4 }] };
      }
      if (sql.includes('MIN(raised_amount)')) {
        return { rows: [{ min_funding: '10', max_funding: '100' }] };
      }
      if (sql.includes("kyc_status = 'verified'")) {
        return { rows: [{ count: 2 }] };
      }
      return { rows: [] };
    },
  };

  // 1. Initial call (cache miss)
  const facets1 = await getCampaignFacets({ client: mockClient });
  assert.equal(dbCallCount, 5); // 5 parallel queries
  assert.deepEqual(facets1.categories, [{ category: 'tech', count: 4 }]);
  assert.equal(cache.has(FACETS_CACHE_KEY), true);
  assert.equal(cache.has(CATEGORY_FACETS_CACHE_KEY), true);
  assert.equal(cache.has(COUNTRY_FACETS_CACHE_KEY), true);

  // 2. Second call (cache hit)
  const facets2 = await getCampaignFacets({ client: mockClient });
  assert.equal(dbCallCount, 5, 'Should not query DB again on cache hit');
  assert.deepEqual(facets2, facets1);

  // 3. Category subkey hit
  const categories = await getCategoryFacets({ client: mockClient });
  assert.equal(dbCallCount, 5, 'Should serve category facets from cache');
  assert.deepEqual(categories, [{ category: 'tech', count: 4 }]);

  // 4. Country subkey hit
  const countries = await getCountryFacets({ client: mockClient });
  assert.equal(dbCallCount, 5, 'Should serve country facets from cache');
  assert.deepEqual(countries, [{ country: 'GB', count: 4 }]);
});

test('getCampaignFacets coalesces concurrent requests (thundering herd protection)', async () => {
  let queryCount = 0;
  const mockClient = {
    query: async () => {
      queryCount++;
      await new Promise(r => setTimeout(r, 15));
      return { rows: [{ count: 1 }] };
    },
  };

  // Launch 10 simultaneous calls on an empty cache
  const results = await Promise.all(
    Array.from({ length: 10 }, () => getCampaignFacets({ client: mockClient }))
  );

  assert.equal(
    queryCount,
    5,
    'Concurrent calls should share in-flight compute and only query 5 DB aggregates'
  );
  for (const r of results) {
    assert.deepEqual(r, results[0]);
  }
});

test('getCampaignFacets with forceRefresh bypasses cache and updates stored entries', async () => {
  let queryBatch = 1;
  const mockClient = {
    query: async sql => {
      if (sql.includes('GROUP BY category')) {
        return { rows: [{ category: queryBatch === 1 ? 'art' : 'science', count: 10 }] };
      }
      return { rows: [{ count: 1 }] };
    },
  };

  const first = await getCampaignFacets({ client: mockClient });
  assert.equal(first.categories[0].category, 'art');

  // Change backend data
  queryBatch = 2;

  // Normal get should still return art (cached)
  const cached = await getCampaignFacets({ client: mockClient });
  assert.equal(cached.categories[0].category, 'art');

  // forceRefresh: true should recompute and return science
  const refreshed = await getCampaignFacets({ client: mockClient, forceRefresh: true });
  assert.equal(refreshed.categories[0].category, 'science');
  assert.equal(cache.get(CATEGORY_FACETS_CACHE_KEY)[0].category, 'science');
});

test('invalidateCampaignFacets explicitly clears facet caches and causes next call to re-query DB', async () => {
  let queryCount = 0;
  const mockClient = {
    query: async () => {
      queryCount++;
      return { rows: [{ count: 1 }] };
    },
  };

  // Seed cache
  await getCampaignFacets({ client: mockClient });
  assert.equal(queryCount, 5);

  // Invalidate
  const invalidationResult = invalidateCampaignFacets();
  assert.equal(invalidationResult.success, true);
  assert.ok(invalidationResult.invalidatedAt);
  assert.equal(cache.has(FACETS_CACHE_KEY), false);
  assert.equal(cache.has(CATEGORY_FACETS_CACHE_KEY), false);
  assert.equal(cache.has(COUNTRY_FACETS_CACHE_KEY), false);

  // Next read must hit DB
  await getCampaignFacets({ client: mockClient });
  assert.equal(queryCount, 10, 'Recomputed from DB after invalidation');
});

test('GET /api/campaigns/facets sets Cache-Control header and supports cache refresh', async () => {
  let categoryName = 'initial-cat';
  let dbQueries = 0;

  const mockDb = {
    query: async sql => {
      dbQueries++;
      if (sql.includes('GROUP BY category')) {
        return { rows: [{ category: categoryName, count: 5 }] };
      }
      if (sql.includes('GROUP BY country')) {
        return { rows: [{ country: 'CA', count: 3 }] };
      }
      if (sql.includes('MIN(raised_amount)')) {
        return { rows: [{ min_funding: '0', max_funding: '500' }] };
      }
      return { rows: [{ count: 1 }] };
    },
  };

  const campaignsRouter = proxyquire('../routes/campaigns', {
    '../config/database': mockDb,
    '../services/campaignFacetService': proxyquire('./campaignFacetService', {
      '../config/database': mockDb,
    }),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', campaignsRouter);

  // 1. Initial request (cache miss)
  const res1 = await request(app).get('/api/campaigns/facets');
  assert.equal(res1.status, 200);
  assert.equal(res1.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=30');
  assert.deepEqual(res1.body.categories, [{ category: 'initial-cat', count: 5 }]);
  assert.equal(dbQueries, 5);

  // 2. Second request (cache hit)
  categoryName = 'updated-cat';
  const res2 = await request(app).get('/api/campaigns/facets');
  assert.equal(res2.status, 200);
  assert.deepEqual(res2.body.categories, [{ category: 'initial-cat', count: 5 }]);
  assert.equal(dbQueries, 5, 'Served from process cache');

  // 3. Request with ?refresh=true forces DB reload
  const res3 = await request(app).get('/api/campaigns/facets?refresh=true');
  assert.equal(res3.status, 200);
  assert.deepEqual(res3.body.categories, [{ category: 'updated-cat', count: 5 }]);
  assert.equal(dbQueries, 10, 'Bypassed cache with refresh query param');
});

test('POST /api/campaigns/facets/invalidate enforces auth and role restrictions and invalidates cache', async () => {
  let authUser = null;
  let dbQueries = 0;

  const mockDb = {
    query: async sql => {
      dbQueries++;
      if (sql.includes('GROUP BY category')) {
        return { rows: [{ category: 'cat-a', count: 2 }] };
      }
      return { rows: [{ count: 1 }] };
    },
  };

  const campaignsRouter = proxyquire('../routes/campaigns', {
    '../config/database': mockDb,
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
        req.user = authUser;
        next();
      },
      requireRole:
        (...roles) =>
        (req, res, next) => {
          if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden' });
          }
          next();
        },
      optionalAuth: (req, res, next) => next(),
    },
    '../services/campaignFacetService': proxyquire('./campaignFacetService', {
      '../config/database': mockDb,
    }),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', campaignsRouter);

  // 1. Seed the cache
  await request(app).get('/api/campaigns/facets');
  assert.equal(dbQueries, 5);

  // 2. Unauthenticated POST /facets/invalidate -> 401
  const unauthRes = await request(app).post('/api/campaigns/facets/invalidate');
  assert.equal(unauthRes.status, 401);

  // 3. Backer role -> 403
  authUser = { userId: 'u1', role: 'backer' };
  const forbiddenRes = await request(app).post('/api/campaigns/facets/invalidate');
  assert.equal(forbiddenRes.status, 403);

  // 4. Creator role -> 200
  authUser = { userId: 'u2', role: 'creator' };
  const creatorRes = await request(app).post('/api/campaigns/facets/invalidate');
  assert.equal(creatorRes.status, 200);
  assert.equal(creatorRes.body.success, true);
  assert.equal(creatorRes.body.message, 'Campaign facets cache invalidated');

  // Next GET /facets should re-query DB
  await request(app).get('/api/campaigns/facets');
  assert.equal(dbQueries, 10, 'Cache was invalidated, next request queried DB');

  // 5. Admin role -> 200
  authUser = { userId: 'u3', role: 'admin' };
  const adminRes = await request(app).post('/api/campaigns/facets/invalidate');
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.body.success, true);

  await request(app).get('/api/campaigns/facets');
  assert.equal(dbQueries, 15);
});
