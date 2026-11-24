'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  const queries = [];
  const service = proxyquire('./nftRewardService', {
    '../config/database': {
      query: async (text, params) => {
        queries.push({ text, params });
        return queryImpl ? queryImpl(text, params) : { rows: [] };
      },
    },
  });
  return { service, queries };
}

test('isNftMintConfigured requires both contract ID and NFT_REWARDS_ENABLED=true', () => {
  const { service } = buildService();
  const prevContract = process.env.NFT_REWARDS_CONTRACT_ID;
  const prevEnabled = process.env.NFT_REWARDS_ENABLED;

  try {
    delete process.env.NFT_REWARDS_CONTRACT_ID;
    delete process.env.NFT_REWARDS_ENABLED;
    assert.equal(service.isNftMintConfigured(), false);

    process.env.NFT_REWARDS_CONTRACT_ID = 'CNFT123';
    process.env.NFT_REWARDS_ENABLED = 'false';
    assert.equal(service.isNftMintConfigured(), false);

    process.env.NFT_REWARDS_ENABLED = 'true';
    assert.equal(service.isNftMintConfigured(), true);
  } finally {
    if (prevContract === undefined) delete process.env.NFT_REWARDS_CONTRACT_ID;
    else process.env.NFT_REWARDS_CONTRACT_ID = prevContract;
    if (prevEnabled === undefined) delete process.env.NFT_REWARDS_ENABLED;
    else process.env.NFT_REWARDS_ENABLED = prevEnabled;
  }
});

test('assertContributionOwnedByUser returns row for owner and throws 403 or 404 otherwise', async () => {
  const { service } = buildService(async (text, params) => {
    if (text.includes('JOIN users u')) {
      if (params[0] === 'contrib-owned' && params[1] === 'user-1') {
        return { rows: [{ id: 'contrib-owned', campaign_id: 'camp-1', amount: '50' }] };
      }
      return { rows: [] };
    }
    if (text.includes('SELECT id FROM contributions')) {
      return { rows: params[0] === 'contrib-owned' ? [{ id: 'contrib-owned' }] : [] };
    }
    return { rows: [] };
  });

  const owned = await service.assertContributionOwnedByUser('contrib-owned', 'user-1');
  assert.equal(owned.id, 'contrib-owned');

  await assert.rejects(
    () => service.assertContributionOwnedByUser('contrib-owned', 'user-2'),
    err => err.statusCode === 403 && err.message === 'Forbidden'
  );

  await assert.rejects(
    () => service.assertContributionOwnedByUser('contrib-missing', 'user-1'),
    err => err.statusCode === 404 && err.message === 'Contribution not found'
  );
});

test('ensureNftRewardRecord inserts minting record and returns null on conflict', async () => {
  const { service } = buildService(async (_text, params) => {
    if (params[2] === 'contrib-dup') return { rows: [] };
    return { rows: [{ id: 'nft-1', status: 'minting' }] };
  });

  const created = await service.ensureNftRewardRecord({
    campaignId: 'camp-1',
    rewardTierId: 'tier-1',
    contributionId: 'contrib-1',
  });
  assert.deepEqual(created, { id: 'nft-1', status: 'minting' });

  const duplicate = await service.ensureNftRewardRecord({
    campaignId: 'camp-1',
    rewardTierId: 'tier-1',
    contributionId: 'contrib-dup',
  });
  assert.equal(duplicate, null);
});

test('markNftRewardMinted rejects mock/missing identifiers and updates valid mint state', async () => {
  const { service, queries } = buildService();

  await assert.rejects(
    () =>
      service.markNftRewardMinted({
        rewardTierId: 'tier-1',
        contributionId: 'c-1',
        tokenId: 'tok_mock_1',
        txHash: 'realhash123',
        serialNumber: 1,
      }),
    /mock identifiers/
  );

  await assert.rejects(
    () =>
      service.markNftRewardMinted({
        rewardTierId: 'tier-1',
        contributionId: 'c-1',
        tokenId: '42',
        txHash: 'hash_mock_1',
        serialNumber: 1,
      }),
    /mock identifiers/
  );

  await service.markNftRewardMinted({
    rewardTierId: 'tier-1',
    contributionId: 'c-1',
    tokenId: '42',
    txHash: 'abc123realhash',
    serialNumber: 7,
    contractId: 'CNFT123',
  });

  assert.equal(queries.length, 1);
  assert.ok(queries[0].text.includes("SET status = 'minted'"));
  assert.deepEqual(queries[0].params, ['42', 'abc123realhash', 7, 'tier-1', 'c-1', 'CNFT123']);
});

test('markNftRewardFailed and query helpers pass expected parameters', async () => {
  const { service, queries } = buildService(async () => ({ rows: [{ id: 'nft-1' }] }));

  await service.markNftRewardFailed({
    rewardTierId: 'tier-1',
    contributionId: 'c-1',
    errorMessage: 'contract trapped',
  });
  assert.ok(queries[0].text.includes("SET status = 'failed'"));
  assert.deepEqual(queries[0].params, ['contract trapped', 'tier-1', 'c-1']);

  const userRewards = await service.getUserNftRewards('user-1');
  assert.equal(userRewards.length, 1);
  assert.deepEqual(queries[1].params, ['user-1']);

  const campRewards = await service.getCampaignNftRewards('camp-1');
  assert.equal(campRewards.length, 1);
  assert.deepEqual(queries[2].params, ['camp-1']);

  const contribRewards = await service.listNftRewardsForContribution('c-1');
  assert.equal(contribRewards.length, 1);
  assert.deepEqual(queries[3].params, ['c-1']);
});
