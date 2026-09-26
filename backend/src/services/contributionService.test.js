const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { toStroops, fromStroops, splitFee } = require('../utils/stroops');

// Mirrors stellarService.calcFee with a fixed 2.5% platform fee.
async function calcFee(amount, bps = 250) {
  const amountStroops = toStroops(amount);
  const { feeStroops, campaignStroops } = splitFee(amountStroops, bps);
  return {
    feeAmount: fromStroops(feeStroops),
    campaignAmount: fromStroops(campaignStroops),
    amountStroops,
    feeStroops,
    campaignStroops,
    bps,
  };
}

function buildService({ sorobanImpl, stellarImpl, stellarTxImpl } = {}) {
  const depositCalls = [];
  const insertCalls = [];
  const prepareCalls = [];
  const submittedCalls = [];

  const sorobanStub = {
    depositToEscrow: async (args) => {
      depositCalls.push(args);
      return { txHash: 'contract-tx-hash', returnValue: null };
    },
    isContractDepositEligible: (campaign) => Boolean(campaign?.escrow_contract_id),
    ...sorobanImpl,
  };

  const stellarStub = {
    prepareSignedContributionPayment: async (args) => {
      prepareCalls.push(args);
      return { unsignedXdr: 'u-xdr', signedXdr: 's-xdr', feeAmount: args.feeSplit.feeAmount };
    },
    prepareSignedContributionPathPayment: async (args) => {
      prepareCalls.push(args);
      return { unsignedXdr: 'u-xdr', signedXdr: 's-xdr', feeAmount: args.feeSplit.feeAmount };
    },
    calcFee,
    submitPreparedTransaction: async () => 'classic-tx-hash',
    getPathPaymentQuote: async () => [],
    ensureCustodialAccountFundedAndTrusted: async () => null,
    ...stellarImpl,
  };

  const stellarTxStub = {
    insertContributionPending: async (_client, row) => {
      insertCalls.push(row);
      return { id: 'stellar-row-id', reused: false };
    },
    markContributionSubmitted: async (_client, id, txHash, extra) => {
      submittedCalls.push({ id, txHash, extra });
    },
    markContributionFailed: async () => {},
    ...stellarTxImpl,
  };

  const service = proxyquire('./contributionService', {
    './stellarService': stellarStub,
    './sorobanService': sorobanStub,
    './walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SDECRYPTEDSECRET'),
    },
    './stellarTransactionService': stellarTxStub,
    '../config/constants': { SLIPPAGE_BPS: 500, STELLAR_ASSET_DECIMALS_SCALE: 10_000_000 },
  });

  return { service, depositCalls, insertCalls, prepareCalls, submittedCalls };
}

const CONTRACT_CAMPAIGN = {
  asset_type: 'USDC',
  wallet_public_key: 'GCAMPAIGNWALLET',
  escrow_contract_id: 'CESCROWCONTRACT',
};

const CLASSIC_CAMPAIGN = {
  asset_type: 'USDC',
  wallet_public_key: 'GCAMPAIGNWALLET',
  escrow_contract_id: null,
};

test('submitCustodialContribution deposits directly into the escrow contract for a contract-mode, same-asset campaign', async () => {
  const { service, depositCalls, insertCalls } = buildService();

  const result = await service.submitCustodialContribution({
    campaign: CONTRACT_CAMPAIGN,
    campaignId: 'camp-1',
    userId: 'user-1',
    walletPublicKey: 'GCONTRIBUTOR',
    walletSecretEncrypted: 'ENCRYPTED',
    amount: '10.0000000',
    sendAsset: 'USDC',
    client: {},
  });

  assert.equal(depositCalls.length, 1);
  assert.equal(depositCalls[0].contractId, 'CESCROWCONTRACT');
  assert.equal(depositCalls[0].fromAddress, 'GCONTRIBUTOR');
  assert.equal(depositCalls[0].amount, 100_000_000n); // 10 * 10^7, exact BigInt stroops
  assert.equal(depositCalls[0].signerSecret, 'SDECRYPTEDSECRET');

  assert.equal(result.txHash, 'contract-tx-hash');
  assert.equal(result.contractMode, true);
  assert.equal(result.unsignedXdr, null);
  assert.equal(result.signedXdr, null);
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].metadata.contract_mode, true);
});

test('submitCustodialContribution rejects a cross-asset contribution to a contract-mode campaign', async () => {
  const { service, depositCalls } = buildService();

  await assert.rejects(
    () =>
      service.submitCustodialContribution({
        campaign: CONTRACT_CAMPAIGN,
        campaignId: 'camp-1',
        userId: 'user-1',
        walletPublicKey: 'GCONTRIBUTOR',
        walletSecretEncrypted: 'ENCRYPTED',
        amount: '10.0000000',
        sendAsset: 'XLM',
        client: {},
      }),
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /cross-asset/i);
      return true;
    }
  );
  assert.equal(depositCalls.length, 0);
});

test('submitCustodialContribution falls back to a classic payment when the campaign is not contract-mode eligible', async () => {
  const { service, depositCalls } = buildService();

  const result = await service.submitCustodialContribution({
    campaign: CLASSIC_CAMPAIGN,
    campaignId: 'camp-1',
    userId: 'user-1',
    walletPublicKey: 'GCONTRIBUTOR',
    walletSecretEncrypted: 'ENCRYPTED',
    amount: '10.0000000',
    sendAsset: 'USDC',
    client: {},
  });

  assert.equal(depositCalls.length, 0);
  assert.equal(result.txHash, 'classic-tx-hash');
  assert.equal(result.contractMode, false);
  assert.equal(result.unsignedXdr, 'u-xdr');
  assert.equal(result.signedXdr, 's-xdr');
});

// --- Exact stroop conversion (#840) -----------------------------------------

function contribute(service, campaign, amount, extra = {}) {
  return service.submitCustodialContribution({
    campaign,
    campaignId: 'camp-1',
    userId: 'user-1',
    walletPublicKey: 'GCONTRIBUTOR',
    walletSecretEncrypted: 'ENCRYPTED',
    amount,
    sendAsset: 'USDC',
    client: {},
    ...extra,
  });
}

test('contract-mode deposits 8.29 and 19.99 as exact stroops (no float drift)', async () => {
  const { service, depositCalls, insertCalls } = buildService();

  await contribute(service, CONTRACT_CAMPAIGN, '8.29');
  await contribute(service, CONTRACT_CAMPAIGN, 19.99);

  assert.equal(depositCalls[0].amount, 82_900_000n);
  assert.equal(depositCalls[1].amount, 199_900_000n);
  assert.equal(insertCalls[0].metadata.amount_stroops, '82900000');
  assert.equal(insertCalls[0].metadata.deposit_amount_stroops, '82900000');
  assert.equal(insertCalls[1].metadata.amount_stroops, '199900000');
});

test('contract-mode deposit of one stroop and of the maximum amount are exact', async () => {
  const { service, depositCalls } = buildService();

  await contribute(service, CONTRACT_CAMPAIGN, '0.0000001');
  await contribute(service, CONTRACT_CAMPAIGN, '922337203685.4775807');

  assert.equal(depositCalls[0].amount, 1n);
  assert.equal(depositCalls[1].amount, 9_223_372_036_854_775_807n);
});

test('zero, negative, over-precise and over-maximum amounts are rejected before any submission', async () => {
  for (const amount of ['0', '-5', '8.290000001', '922337203685.4775808', 'abc']) {
    const { service, depositCalls, insertCalls, prepareCalls } = buildService();
    await assert.rejects(contribute(service, CONTRACT_CAMPAIGN, amount), (err) => err.statusCode === 400);
    await assert.rejects(contribute(service, CLASSIC_CAMPAIGN, amount), (err) => err.statusCode === 400);
    assert.equal(depositCalls.length, 0, `no deposit for ${amount}`);
    assert.equal(prepareCalls.length, 0, `no payment for ${amount}`);
    assert.equal(insertCalls.length, 0, `nothing persisted for ${amount}`);
  }
});

test('classic payment, fee metadata and persisted contribution reconcile to the stroop', async () => {
  const { service, insertCalls, prepareCalls } = buildService();

  const result = await contribute(service, CLASSIC_CAMPAIGN, '8.29');

  const metadata = insertCalls[0].metadata;
  const split = prepareCalls[0].feeSplit;
  assert.equal(prepareCalls[0].amount, '8.2900000');
  assert.equal(split.feeAmount, '0.2072500');
  assert.equal(split.campaignAmount, '8.0827500');
  assert.equal(toStroops(split.feeAmount) + toStroops(split.campaignAmount), 82_900_000n);

  assert.equal(metadata.amount, '8.2900000');
  assert.equal(metadata.amount_stroops, '82900000');
  assert.equal(metadata.platform_fee_amount, '0.2072500');
  assert.equal(metadata.platform_fee_stroops, '2072500');
  assert.equal(metadata.campaign_net_amount, '8.0827500');

  assert.equal(result.platformFeeAmount, '0.2072500');
  assert.equal(result.destinationAmount, '8.2900000', 'API monetary values stay decimal strings');
  assert.equal(typeof result.destinationAmount, 'string');
});

test('contract-mode contributions record a zero classic fee as a decimal string', async () => {
  const { service, insertCalls } = buildService();

  const result = await contribute(service, CONTRACT_CAMPAIGN, '19.99');

  assert.equal(result.platform_fee_amount, '0.0000000');
  assert.equal(insertCalls[0].metadata.platform_fee_amount, '0.0000000');
  assert.equal(insertCalls[0].metadata.campaign_net_amount, '19.9900000');
});

test('a PATH_PAYMENT_OVER_SENDMAX failure is re-quoted once with an exact sendMax and recorded on the row', async () => {
  let submits = 0;
  const { service, prepareCalls, submittedCalls, insertCalls } = buildService({
    stellarImpl: {
      getPathPaymentQuote: async () => [{ source_amount: '8.29', destination_amount: '8.29', path: [] }],
      submitPreparedTransaction: async () => {
        submits += 1;
        if (submits === 1) throw new Error('op_over_source_max PATH_PAYMENT_OVER_SENDMAX');
        return 'retried-tx-hash';
      },
    },
  });

  const result = await contribute(service, CLASSIC_CAMPAIGN, '8.29', { sendAsset: 'XLM' });

  assert.equal(result.txHash, 'retried-tx-hash');
  assert.equal(insertCalls.length, 1, 'exactly one pending row, recorded before submission');
  // 8.29 * 1.05 = 8.7045 exactly; the float path gave 8.7045000 only by luck.
  assert.equal(prepareCalls[0].sendMax, '8.7045000');
  assert.equal(prepareCalls[1].sendMax, '8.7045000');
  assert.equal(submittedCalls[0].extra.metadata.retry_count, 1);
  assert.equal(submittedCalls[0].extra.metadata.send_max, '8.7045000');
});
