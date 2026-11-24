'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();

function buildService({
  cachedValue = null,
  contributions = [],
  campaign = { currency: 'USDC' },
} = {}) {
  const redisSets = [];
  let contributionFindCalls = 0;

  const service = proxyquire('./impactSealService', {
    '../config/redis': {
      get: async () => cachedValue,
      set: async (...args) => redisSets.push(args),
    },
    '../config/constants': {
      IMPACT_CACHE_TTL_SECONDS: 60,
    },
    '../models': {
      Contribution: {
        findAll: async () => {
          contributionFindCalls++;
          return contributions;
        },
      },
      Campaign: {
        findByPk: async () => campaign,
      },
    },
  });

  return {
    service,
    redisSets,
    getContributionFindCalls: () => contributionFindCalls,
  };
}

test('getImpactStats returns cached stats from Redis without querying models', async () => {
  const cached = { total_raised: 500, contribution_count: 5, currency: 'USDC' };
  const { service, redisSets, getContributionFindCalls } = buildService({
    cachedValue: JSON.stringify(cached),
  });

  const stats = await service.getImpactStats('camp-1');

  assert.deepEqual(stats, cached);
  assert.equal(getContributionFindCalls(), 0);
  assert.equal(redisSets.length, 0);
});

test('getImpactStats computes aggregate metrics and caches in Redis on cache miss', async () => {
  const { service, redisSets } = buildService({
    contributions: [
      { amount: '100', contributorPublicKey: 'GPK1' },
      { amount: '50', contributorPublicKey: 'GPK2' },
      { amount: '150', contributorPublicKey: 'GPK1' },
    ],
    campaign: { currency: 'XLM' },
  });

  const stats = await service.getImpactStats('camp-2');

  assert.deepEqual(stats, {
    total_raised: 300,
    contribution_count: 3,
    average_contribution: 100,
    largest_contribution: 150,
    unique_contributor_count: 2,
    currency: 'XLM',
  });
  assert.equal(redisSets.length, 1);
  assert.deepEqual(redisSets[0], ['impact:camp-2', JSON.stringify(stats), 'EX', 60]);
});

test('getImpactStats handles campaigns with zero contributions', async () => {
  const { service } = buildService({ contributions: [], campaign: { currency: 'USDC' } });

  const stats = await service.getImpactStats('camp-empty');

  assert.deepEqual(stats, {
    total_raised: 0,
    contribution_count: 0,
    average_contribution: 0,
    largest_contribution: 0,
    unique_contributor_count: 0,
    currency: 'USDC',
  });
});

test('signStats throws when IMPACT_SIGNING_SECRET is missing and signs with HMAC-SHA256 when set', () => {
  const { service } = buildService();
  const prevSecret = process.env.IMPACT_SIGNING_SECRET;
  delete process.env.IMPACT_SIGNING_SECRET;

  try {
    assert.throws(
      () => service.signStats({ total_raised: 100 }, 'camp-1'),
      /IMPACT_SIGNING_SECRET/
    );

    process.env.IMPACT_SIGNING_SECRET = 'super-secret-impact-key';
    const stats = { total_raised: 100, contribution_count: 2 };
    const signed = service.signStats(stats, 'camp-1');

    const expectedSig = crypto
      .createHmac('sha256', 'super-secret-impact-key')
      .update(JSON.stringify({ campaign_id: 'camp-1', ...stats }))
      .digest('hex');

    assert.equal(signed.campaign_id, 'camp-1');
    assert.equal(signed.signature, expectedSig);
    assert.equal(signed.algorithm, 'HMAC-SHA256');
    assert.ok(signed.signed_at);
  } finally {
    if (prevSecret === undefined) delete process.env.IMPACT_SIGNING_SECRET;
    else process.env.IMPACT_SIGNING_SECRET = prevSecret;
  }
});
