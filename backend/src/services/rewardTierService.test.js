const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const MODULE_PATH = './rewardTierService';

function buildService({ queryImpl } = {}) {
  return proxyquire(MODULE_PATH, {
    '../config/database': { query: queryImpl || (async () => ({ rows: [] })) },
    '../lib/sanitize': { stripHtml: (s) => String(s || '') },
  });
}

function mockClient(queryImpl) {
  return { query: queryImpl || (async () => ({ rows: [] })) };
}

test.describe('rewardTierService', () => {
  test('validateTiersInput treats undefined/null as no tiers', () => {
    const svc = buildService();
    assert.deepEqual(svc.validateTiersInput(undefined, 'USDC'), []);
    assert.deepEqual(svc.validateTiersInput(null, 'USDC'), []);
  });

  test('validateTiersInput rejects non-array input', () => {
    const svc = buildService();
    assert.throws(() => svc.validateTiersInput({}, 'USDC'), /reward_tiers must be an array/);
  });

  test('validateTiersInput caps tiers at MAX_TIERS_PER_CAMPAIGN', () => {
    const svc = buildService();
    const tiers = Array(11).fill({ title: 'T', min_amount: 1 });
    assert.throws(() => svc.validateTiersInput(tiers, 'USDC'), /at most 10 reward tiers/);
    const ok = svc.validateTiersInput(tiers.slice(0, 10), 'USDC');
    assert.equal(ok.length, 10);
  });

  test('validateTiersInput requires a title', () => {
    const svc = buildService();
    assert.throws(() => svc.validateTiersInput([{ title: '', min_amount: 5 }], 'USDC'), /reward_tiers\[0\]: title is required/);
  });

  test('validateTiersInput requires a positive min_amount', () => {
    const svc = buildService();
    assert.throws(() => svc.validateTiersInput([{ title: 'T', min_amount: 0 }], 'USDC'), /min_amount must be a positive number/);
    assert.throws(() => svc.validateTiersInput([{ title: 'T' }], 'USDC'), /min_amount must be a positive number/);
  });

  test('validateTiersInput requires asset_type to match the campaign asset', () => {
    const svc = buildService();
    assert.throws(
      () => svc.validateTiersInput([{ title: 'T', min_amount: 5, asset_type: 'XLM' }], 'USDC'),
      /asset_type must match the campaign asset \(USDC\)/
    );
  });

  test('validateTiersInput defaults asset_type to the campaign asset', () => {
    const svc = buildService();
    const tiers = svc.validateTiersInput([{ title: 'T', min_amount: 5 }], 'XLM');
    assert.equal(tiers[0].asset_type, 'XLM');
  });

  test('validateTiersInput validates limit', () => {
    const svc = buildService();
    assert.throws(
      () => svc.validateTiersInput([{ title: 'T', min_amount: 5, limit: 1.5 }], 'USDC'),
      /limit must be a positive whole number/
    );
    assert.throws(
      () => svc.validateTiersInput([{ title: 'T', min_amount: 5, limit: -2 }], 'USDC'),
      /limit must be a positive whole number/
    );
  });

  test('validateTiersInput validates estimated_delivery as a date', () => {
    const svc = buildService();
    assert.throws(
      () => svc.validateTiersInput([{ title: 'T', min_amount: 5, estimated_delivery: 'not-a-date' }], 'USDC'),
      /estimated_delivery must be a valid date/
    );
  });

  test('validateTiersInput normalizes a full tier object', () => {
    const svc = buildService();
    const tiers = svc.validateTiersInput(
      [{
        title: ' <b>Gold</b> ',
        description: '<i> desc </i>',
        min_amount: '25',
        limit: '3',
        estimated_delivery: '2026-12-31',
        nft_enabled: true,
        nft_metadata_url: 'https://x/metadata',
        nft_artwork_url: 'https://x/art',
      }],
      'USDC'
    );
    assert.deepEqual(tiers[0], {
      title: ' <b>Gold</b> ',
      description: '<i> desc </i>',
      min_amount: 25,
      asset_type: 'USDC',
      tier_limit: 3,
      estimated_delivery: '2026-12-31',
      nft_enabled: true,
      nft_metadata_url: 'https://x/metadata',
      nft_artwork_url: 'https://x/art',
    });
  });

  test('insertTiers inserts each tier and creates nft_rewards for NFT tiers', async () => {
    const client = mockClient(async (text, params) => {
      if (text.includes('INSERT INTO reward_tiers')) {
        return { rows: [{ id: `tier-${params[0]}-${params[3]}`, title: params[1] }] };
      }
      if (text.includes('INSERT INTO nft_rewards')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const svc = buildService();

    const created = await svc.insertTiers(client, 'c-1', [
      { title: 'Basic', description: null, min_amount: 5, asset_type: 'USDC', tier_limit: null, estimated_delivery: null, nft_enabled: false, nft_metadata_url: null, nft_artwork_url: null },
      { title: 'NFT', description: 'r', min_amount: 10, asset_type: 'USDC', tier_limit: 5, estimated_delivery: null, nft_enabled: true, nft_metadata_url: 'https://m', nft_artwork_url: 'https://a' },
    ]);

    assert.equal(created.length, 2);
    assert.equal(created[1].nft_enabled, true);
    assert.match(created[1].title, /NFT/);
  });

  test('listTiersWithAvailability returns whatever the db gives', async () => {
    const svc = buildService({
      queryImpl: async (text, params) => {
        assert.match(text, /SELECT rt\.id, rt\.campaign_id/);
        assert.deepEqual(params, ['c-1']);
        return { rows: [{ id: 't1', title: 'T', remaining: 2, sold_out: false }] };
      },
    });
    const rows = await svc.listTiersWithAvailability('c-1');
    assert.equal(rows[0].id, 't1');
  });

  test('reserveTierSlot increments claimed_count and returns the tier', async () => {
    const client = mockClient(async (text, params) => {
      assert.match(text, /claimed_count = claimed_count \+ 1/);
      assert.deepEqual(params, ['tier-1', 'c-1']);
      return { rows: [{ id: 'tier-1', title: 'Gold' }] };
    });
    const svc = buildService();
    const slot = await svc.reserveTierSlot(client, { tierId: 'tier-1', campaignId: 'c-1' });
    assert.deepEqual(slot, { id: 'tier-1', title: 'Gold' });
  });

  test('reserveTierSlot returns null when the tier is sold out', async () => {
    const client = mockClient(async () => ({ rows: [] }));
    const svc = buildService();
    const slot = await svc.reserveTierSlot(client, { tierId: 'tier-1', campaignId: 'c-1' });
    assert.equal(slot, null);
  });

  test('assignTierToContribution with an explicit tierId only creates the join row (no bump)', async () => {
    const client = mockClient(async (text, params) => {
      assert.match(text, /INSERT INTO contribution_rewards/);
      assert.ok(!/claimed_count \+ 1/.test(text));
      assert.deepEqual(params, ['con-1', 'tier-1']);
      return { rows: [{ id: 'tier-1', title: 'Gold', nft_enabled: false }] };
    });
    const svc = buildService();
    const assigned = await svc.assignTierToContribution(client, {
      campaignId: 'c-1',
      amount: 20,
      contributionId: 'con-1',
      tierId: 'tier-1',
    });
    assert.equal(assigned.title, 'Gold');
  });

  test('assignTierToContribution auto-matches the highest qualifying tier when no tierId', async () => {
    const client = mockClient(async (text, params) => {
      assert.match(text, /ORDER BY min_amount DESC/);
      assert.match(text, /claimed_count = claimed_count \+ 1/);
      assert.deepEqual(params, ['c-1', 20, 'con-1']);
      return { rows: [{ id: 'tier-2', title: 'Silver', nft_enabled: false }] };
    });
    const svc = buildService();
    const assigned = await svc.assignTierToContribution(client, {
      campaignId: 'c-1',
      amount: 20,
      contributionId: 'con-1',
    });
    assert.equal(assigned.title, 'Silver');
  });

  test('assignTierToContribution returns null when no tier qualifies', async () => {
    const client = mockClient(async () => ({ rows: [] }));
    const svc = buildService();
    const assigned = await svc.assignTierToContribution(client, {
      campaignId: 'c-1',
      amount: 1,
      contributionId: 'con-1',
    });
    assert.equal(assigned, null);
  });
});