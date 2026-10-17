'use strict';

/**
 * Contract upgrade service tests (Issue #679). Postgres and the Soroban RPC
 * layer are both stubbed, so these cover the service's own logic: the
 * active-review gate, guarding against a double upgrade, and the
 * deploy -> initialize -> migrate -> persist happy path.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const CREATOR_KEY = 'GD3I6UAGVCRIWVC5SVFHIHARP7IXKBGKUL74JTCU64T5LCQKFPYAYCC5';
const PLATFORM_SECRET = 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR';

function campaignRow(overrides = {}) {
  return {
    id: CAMPAIGN_ID,
    title: 'Test Campaign',
    escrow_contract_id: 'CESCROWV1',
    milestones_contract_id: 'CMILESTONESV1',
    escrow_contract_version: 1,
    creator_public_key: CREATOR_KEY,
    ...overrides,
  };
}

function build({ queryImpl, soroban = {} } = {}) {
  const calls = [];
  const sorobanStub = {
    deployMilestonesV2Contract: async () => ({ contractId: 'CMILESTONESV2', txHash: 'deploy-tx' }),
    deployMigrationContract: async () => ({
      contractId: 'CMIGRATION',
      txHash: 'deploy-migration-tx',
    }),
    initializeMilestones: async params => {
      calls.push({ fn: 'initializeMilestones', params });
    },
    runMigration: async params => {
      calls.push({ fn: 'runMigration', params });
      return { txHash: 'migrate-tx', milestoneCount: 2 };
    },
    ...soroban,
  };

  const service = proxyquire('./contractUpgrade', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info() {}, warn() {}, error() {} },
    './sorobanService': sorobanStub,
  });

  return { service, calls };
}

test('refuses to upgrade a campaign with a milestone under review', async () => {
  const { service } = build({
    queryImpl: async text => {
      if (text.includes('FROM campaigns c')) return { rows: [campaignRow()] };
      if (text.includes("status = 'pending_review'")) return { rows: [{ id: 'm1' }] };
      throw new Error(`Unexpected query: ${text}`);
    },
  });

  await assert.rejects(
    () => service.upgradeCampaignContract(CAMPAIGN_ID, 'admin-1'),
    err => {
      assert.equal(err.code, 'ACTIVE_REVIEW_IN_PROGRESS');
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('refuses to upgrade a campaign already on V2', async () => {
  const { service } = build({
    queryImpl: async text => {
      if (text.includes('FROM campaigns c')) {
        return { rows: [campaignRow({ escrow_contract_version: 2 })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  });

  await assert.rejects(
    () => service.upgradeCampaignContract(CAMPAIGN_ID, 'admin-1'),
    err => {
      assert.equal(err.code, 'ALREADY_V2');
      return true;
    }
  );
});

test('refuses a second concurrent upgrade for the same campaign', async () => {
  const { service } = build({
    queryImpl: async text => {
      if (text.includes('FROM campaigns c')) return { rows: [campaignRow()] };
      if (text.includes("status = 'pending_review'")) return { rows: [] };
      if (text.includes('SELECT title, release_percentage FROM milestones')) {
        return { rows: [{ title: 'M1', release_percentage: '100' }] };
      }
      if (text.includes('SET migration_in_progress = TRUE')) return { rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
  });

  await assert.rejects(
    () => service.upgradeCampaignContract(CAMPAIGN_ID, 'admin-1'),
    err => {
      assert.equal(err.code, 'MIGRATION_ALREADY_IN_PROGRESS');
      return true;
    }
  );
});

test('happy path deploys V2, migrates V1 state across, and persists the new contract id', async t => {
  const originalSecret = process.env.PLATFORM_SECRET_KEY;
  process.env.PLATFORM_SECRET_KEY = PLATFORM_SECRET;
  t.after(() => {
    process.env.PLATFORM_SECRET_KEY = originalSecret;
  });

  const updates = [];
  const { service, calls } = build({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns c')) return { rows: [campaignRow()] };
      if (text.includes("status = 'pending_review'")) return { rows: [] };
      if (text.includes('SELECT title, release_percentage FROM milestones')) {
        return {
          rows: [
            { title: 'M1', release_percentage: '40' },
            { title: 'M2', release_percentage: '60' },
          ],
        };
      }
      if (text.includes('SET migration_in_progress = TRUE')) return { rowCount: 1 };
      if (text.includes('SET previous_milestones_contract_id')) {
        updates.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  });

  const result = await service.upgradeCampaignContract(CAMPAIGN_ID, 'admin-1');

  assert.equal(result.v1ContractId, 'CMILESTONESV1');
  assert.equal(result.v2ContractId, 'CMILESTONESV2');
  assert.equal(result.migrationTxHash, 'migrate-tx');
  assert.equal(result.milestoneCount, 2);

  const initCall = calls.find(c => c.fn === 'initializeMilestones');
  assert.equal(initCall.params.contractId, 'CMILESTONESV2');
  assert.equal(initCall.params.escrowContractId, 'CESCROWV1');
  assert.equal(initCall.params.milestones.length, 2);

  const migrateCall = calls.find(c => c.fn === 'runMigration');
  assert.equal(migrateCall.params.v1ContractId, 'CMILESTONESV1');
  assert.equal(migrateCall.params.v2ContractId, 'CMILESTONESV2');

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], ['CMILESTONESV2', CAMPAIGN_ID]);
});

test('clears migration_in_progress and rethrows if the on-chain deploy fails', async () => {
  const originalSecret = process.env.PLATFORM_SECRET_KEY;
  process.env.PLATFORM_SECRET_KEY = PLATFORM_SECRET;

  let clearedFlag = false;
  const { service } = build({
    queryImpl: async text => {
      if (text.includes('FROM campaigns c')) return { rows: [campaignRow()] };
      if (text.includes("status = 'pending_review'")) return { rows: [] };
      if (text.includes('SELECT title, release_percentage FROM milestones')) {
        return { rows: [{ title: 'M1', release_percentage: '100' }] };
      }
      if (text.includes('SET migration_in_progress = TRUE')) return { rowCount: 1 };
      if (text.includes('SET migration_in_progress = FALSE WHERE id')) {
        clearedFlag = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    soroban: {
      deployMilestonesV2Contract: async () => {
        throw new Error('RPC unavailable');
      },
    },
  });

  await assert.rejects(
    () => service.upgradeCampaignContract(CAMPAIGN_ID, 'admin-1'),
    /RPC unavailable/
  );
  assert.equal(clearedFlag, true);

  process.env.PLATFORM_SECRET_KEY = originalSecret;
});
