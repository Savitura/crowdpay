const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadService(queryImpl) {
  return proxyquire('./categoryFollowService', {
    '../config/database': { query: queryImpl },
  });
}

test('normalizeCategory lowercases/trims and rejects unknown values', () => {
  const { normalizeCategory, VALID_CATEGORIES } = loadService(async () => ({ rows: [] }));
  assert.equal(normalizeCategory('  Technology '), 'technology');
  assert.equal(normalizeCategory('OPEN_SOURCE'), 'open_source');
  assert.equal(normalizeCategory('nope'), null);
  assert.equal(normalizeCategory(null), null);
  assert.equal(normalizeCategory(42), null);
  assert.deepEqual(VALID_CATEGORIES, [
    'technology',
    'community',
    'arts',
    'education',
    'environment',
    'health',
    'business',
    'open_source',
    'other',
  ]);
});

test('followCategory rejects invalid categories with VALIDATION_ERROR', async () => {
  const service = loadService(async () => ({ rows: [] }));
  await assert.rejects(
    () => service.followCategory('user-1', 'nope'),
    err => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    }
  );
});

test('followCategory creates a new follow (201 path)', async () => {
  const calls = [];
  const service = loadService(async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ category: 'arts', created_at: '2026-09-30T00:00:00.000Z' }] };
  });
  const result = await service.followCategory('user-1', 'Arts');
  assert.deepEqual(result, {
    category: 'arts',
    following: true,
    created: true,
    created_at: '2026-09-30T00:00:00.000Z',
  });
  assert.match(calls[0].text, /ON CONFLICT \(user_id, category\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ['user-1', 'arts']);
});

test('followCategory duplicate is idempotent via conflict + select', async () => {
  const calls = [];
  const service = loadService(async (text, params) => {
    calls.push({ text, params });
    if (text.startsWith('INSERT INTO category_follows')) return { rows: [] };
    return { rows: [{ category: 'health', created_at: '2026-09-01T00:00:00.000Z' }] };
  });
  const result = await service.followCategory('user-1', 'health');
  assert.equal(result.created, false);
  assert.equal(result.following, true);
  assert.equal(result.category, 'health');
  assert.equal(calls.length, 2);
});

test('followCategory concurrent delete-then-retry still deterministic', async () => {
  let inserts = 0;
  const service = loadService(async text => {
    if (text.startsWith('INSERT INTO category_follows')) {
      inserts += 1;
      return { rows: [] };
    }
    return { rows: [] };
  });
  const result = await service.followCategory('user-1', 'education');
  assert.deepEqual(result, {
    category: 'education',
    following: false,
    created: false,
    created_at: null,
  });
  assert.equal(inserts, 2);
});

test('unfollowCategory is idempotent and validates input', async () => {
  const calls = [];
  const service = loadService(async (text, params) => {
    calls.push({ text, params });
    return { rowCount: 0 };
  });
  assert.equal(await service.unfollowCategory('user-1', 'technology'), false);
  assert.deepEqual(calls[0].params, ['user-1', 'technology']);
  await assert.rejects(
    () => service.unfollowCategory('user-1', 'bogus'),
    /category must be one of/
  );
});

test('listFollowedCategories scopes to the requesting user', async () => {
  const calls = [];
  const service = loadService(async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ category: 'arts', followed_at: '2026-09-01T00:00:00.000Z' }] };
  });
  const rows = await service.listFollowedCategories('user-9');
  assert.deepEqual(rows, [{ category: 'arts', followed_at: '2026-09-01T00:00:00.000Z' }]);
  assert.deepEqual(calls[0].params, ['user-9']);
});

test('listNewCampaignsInCategories caps at 5 per category within 20 total', async () => {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      id: `tech-${i}`,
      title: `Tech ${i}`,
      category: 'technology',
      created_at: '2026-09-29T00:00:00.000Z',
    });
  }
  rows.push({
    id: 'arts-1',
    title: 'Arts 1',
    category: 'arts',
    created_at: '2026-09-29T00:00:00.000Z',
  });
  const service = loadService(async () => ({ rows }));
  const result = await service.listNewCampaignsInCategories(
    ['technology', 'arts'],
    new Date('2026-09-23T00:00:00.000Z'),
    new Date('2026-09-30T00:00:00.000Z')
  );
  assert.equal(result.length, 6);
  assert.equal(result.filter(r => r.category === 'technology').length, 5);
});

test('listNewCampaignsInCategories returns [] without categories and without querying', async () => {
  let queried = false;
  const service = loadService(async () => {
    queried = true;
    return { rows: [] };
  });
  const result = await service.listNewCampaignsInCategories([], new Date(), new Date());
  assert.deepEqual(result, []);
  assert.equal(queried, false);
});
