const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService() {
  return proxyquire('./sorobanService', {
    '../config/stellar': {
      server: {
        loadAccount: async () => ({ sequence: '1' }),
        simulateTransaction: async () => ({ result: null }),
        prepareTransaction: (tx) => tx,
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      },
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
    '../config/constants': { TX_TIMEOUT_CONTRIBUTION_S: 30 },
  });
}

test('mapMilestoneOnChainStatus maps numeric contract statuses', () => {
  const { mapMilestoneOnChainStatus } = buildService();
  assert.equal(mapMilestoneOnChainStatus(0), 'pending');
  assert.equal(mapMilestoneOnChainStatus(1), 'submitted');
  assert.equal(mapMilestoneOnChainStatus(2), 'released');
  assert.equal(mapMilestoneOnChainStatus(3), 'rejected');
});

test('releaseMilestone throws when milestones contract is missing', async () => {
  const { releaseMilestone } = buildService();
  await assert.rejects(
    () => releaseMilestone({ milestonesContractId: null, milestoneIndex: 0, signerSecret: 'S' }),
    /does not have a milestones contract/
  );
});

test('triggerRefund throws when escrow contract is missing', async () => {
  const { triggerRefund } = buildService();
  await assert.rejects(
    () => triggerRefund({ escrowContractId: null, contributorAddress: 'GABC', signerSecret: 'S' }),
    /does not have an escrow contract/
  );
});

test('deployCampaignContracts throws when enabled without wasm hashes', async () => {
  const prevEnabled = process.env.SOROBAN_ENABLED;
  const prevEscrow = process.env.ESCROW_WASM_HASH;
  const prevMilestones = process.env.MILESTONES_WASM_HASH;
  process.env.SOROBAN_ENABLED = 'true';
  delete process.env.ESCROW_WASM_HASH;
  delete process.env.MILESTONES_WASM_HASH;

  const { deployCampaignContracts } = buildService();
  await assert.rejects(
    () => deployCampaignContracts({
      creatorPublicKey: 'GCREATOR',
      platformPublicKey: 'GPLATFORM',
      campaignId: 'abc',
      targetAmount: 100,
      deadlineUnix: 1,
      assetContractAddress: 'GASSET',
      platformFeeBps: 0,
      milestones: [],
      signerSecret: 'S' + 'A'.repeat(55),
    }),
    /WASM_HASH/
  );

  process.env.SOROBAN_ENABLED = prevEnabled;
  if (prevEscrow) process.env.ESCROW_WASM_HASH = prevEscrow;
  if (prevMilestones) process.env.MILESTONES_WASM_HASH = prevMilestones;
});
