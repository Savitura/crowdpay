const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');
const { Keypair } = require('@stellar/stellar-sdk');

test('revokeAndCloseCampaignWallet returns no_wallet_public_key when campaign has no wallet', async () => {
  const { revokeAndCloseCampaignWallet } = require('./stellarService');
  const res = await revokeAndCloseCampaignWallet({});
  assert.deepEqual(res, { cleanedUp: false, reason: 'no_wallet_public_key' });
});

test('revokeAndCloseCampaignWallet returns account_not_on_ledger when wallet is not on Stellar', async () => {
  const { revokeAndCloseCampaignWallet } = require('./stellarService');
  const randomKey = Keypair.random().publicKey();
  const res = await revokeAndCloseCampaignWallet({ wallet_public_key: randomKey });
  assert.deepEqual(res, { cleanedUp: false, reason: 'account_not_on_ledger' });
});

test('revokeAndCloseCampaignWallet sweeps funds, revokes platform signer, and merges account on ledger', async () => {
  let submittedTx = null;
  const campaignKeypair = Keypair.random();
  const pubKey = campaignKeypair.publicKey();

  const mockServer = {
    loadAccount: async key => ({
      accountId: () => key,
      sequenceNumber: () => '100',
      incrementSequenceNumber: () => {},
      balances: [
        { asset_type: 'native', balance: '10.0000000' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          balance: '25.5000000',
        },
      ],
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
      signers: [{ key, weight: 1 }],
    }),
    submitTransaction: async tx => {
      submittedTx = tx;
      return { hash: 'mock_tx_hash_123' };
    },
  };

  const mockedStellarService = proxyquire('./stellarService', {
    '../config/stellar': {
      server: mockServer,
      networkPassphrase: 'Test SDF Network ; July 2015',
      USDC: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      isTestnet: true,
      configuredAssets: {
        USDC: { issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      },
    },
    '../config/database': {
      query: async () => ({ rows: [] }),
    },
  });

  const res = await mockedStellarService.revokeAndCloseCampaignWallet({
    id: 'campaign-1',
    wallet_public_key: pubKey,
  });

  assert.equal(res.cleanedUp, true);
  assert.equal(res.hash, 'mock_tx_hash_123');
  assert.ok(submittedTx);

  const ops = submittedTx.operations;
  // Expected ops:
  // 1. Payment (USDC sweep)
  // 2. ChangeTrust (USDC limit 0)
  // 3. SetOptions (platform signer weight 0)
  // 4. AccountMerge (to platform account)
  assert.equal(ops.length, 4);
  assert.equal(ops[0].type, 'payment');
  assert.equal(ops[0].amount, '25.5000000');
  assert.equal(ops[1].type, 'changeTrust');
  assert.ok(ops[1].limit === '0' || ops[1].limit === '0.0000000');
  assert.equal(ops[2].type, 'setOptions');
  assert.equal(ops[2].signer.weight, 0);
  assert.equal(ops[3].type, 'accountMerge');
});
