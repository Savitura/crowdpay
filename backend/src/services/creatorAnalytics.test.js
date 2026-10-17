const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  return proxyquire('./creatorAnalytics', {
    '../config/database': { query: queryImpl || (async () => ({ rows: [] })) },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
  });
}

test('classifyBracket buckets amounts into small/medium/large', () => {
  const { classifyBracket } = buildService();
  assert.equal(classifyBracket(0), 'small');
  assert.equal(classifyBracket(4999), 'small');
  assert.equal(classifyBracket(5000), 'medium');
  assert.equal(classifyBracket(49999), 'medium');
  assert.equal(classifyBracket(50000), 'large');
  assert.equal(classifyBracket(1_000_000), 'large');
});

test('checkExportRateLimit allows the full daily quota when no exports have run yet', async () => {
  const { checkExportRateLimit, EXPORT_DAILY_LIMIT } = buildService(async () => ({ rows: [] }));
  const result = await checkExportRateLimit('creator-1');
  assert.deepEqual(result, { allowed: true, remaining: EXPORT_DAILY_LIMIT });
});

test('checkExportRateLimit blocks once the daily export quota is used up', async () => {
  const { checkExportRateLimit, EXPORT_DAILY_LIMIT } = buildService(async () => ({
    rows: [{ export_count: EXPORT_DAILY_LIMIT }],
  }));
  const result = await checkExportRateLimit('creator-1');
  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

test('incrementExportCount upserts today\'s export count for the creator', async () => {
  const calls = [];
  const { incrementExportCount } = buildService(async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  });

  await incrementExportCount('creator-1');

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO creator_export_rate_limits/);
  assert.match(calls[0].text, /ON CONFLICT \(creator_id, export_date\)/);
  assert.deepEqual(calls[0].params, ['creator-1']);
});
