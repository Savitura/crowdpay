const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Networks } = require('@stellar/stellar-sdk');

process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-for-contributions-32';

const CAMPAIGN = {
  id: 'camp-1',
  status: 'active',
  asset_type: 'XLM',
  wallet_public_key: 'GCAMPAIGN',
  creator_email: 'creator@example.com',
  raised_amount: '0',
  target_amount: '1000',
};

function buildApp({ resolveReferralLink, onSubmit }) {
  const queryImpl = async (text) => {
    if (text.includes('FROM campaigns c')) return { rows: [CAMPAIGN] };
    if (text.includes('wallet_secret_encrypted')) {
      return { rows: [{ wallet_secret_encrypted: 'enc', wallet_public_key: 'GCONTRIB' }] };
    }
    if (text.includes('wallet_type')) {
      return { rows: [{ wallet_type: 'custodial', wallet_public_key: 'GCONTRIB', wallet_funded_at: new Date() }] };
    }
    return { rows: [] };
  };

  const router = proxyquire('./contributions', {
    '../config/stellar': { networkPassphrase: Networks.TESTNET, isTestnet: true },
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      buildUnsignedContributionPayment: async () => 'unsigned-xdr',
      buildUnsignedContributionPathPayment: async () => 'unsigned-xdr',
      submitPreparedTransaction: async () => 'tx-hash',
      getPathPaymentQuote: async () => [],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      isBadSequenceError: () => false,
      accountExistsOnLedger: async () => true,
    },
    '../services/stellarTransactionService': { insertContributionSubmitted: async () => 'stellar-row' },
    '../services/contributionService': {
      buildAttributionMemo: (campaignId, code) => (code ? `ref:${code}` : `cp-${campaignId}`),
      buildContributionIntent: async () => ({ kind: 'payment', conversionQuote: null, flowMetadata: {} }),
      submitCustodialContribution: async (params) => {
        onSubmit?.(params);
        return { txHash: 'tx-hash', stellarTransactionId: 'stellar-row', conversionQuote: null };
      },
    },
    '../services/referral': { resolveReferralLink },
    '../services/referralService': { getReferralCodeFromRequest: () => null },
    '../services/rewardTierService': { reserveTierSlot: async () => null },
    '../services/sorobanService': { triggerRefund: async () => null },
    '../services/kycService': { assertUserKycVerified: async () => {} },
    '../services/contributorIdentityService': { assertContributorMeetsRequirements: async () => {} },
    '../services/emailService': { sendEmail: async () => {} },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../middleware/validation': {
      contributionValidation: [],
      contributionQuoteValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contributions', router);
  return app;
}

test('POST /api/contributions?ref=CODE attributes the contribution to the referral link', async () => {
  let submitted;
  const app = buildApp({
    resolveReferralLink: async ({ campaignId, code }) => {
      assert.equal(campaignId, 'camp-1');
      assert.equal(code, 'a1b2c3d4');
      return { id: 'link-1', campaign_id: 'camp-1', user_id: 'user-2', code: 'a1b2c3d4' };
    },
    onSubmit: (params) => {
      submitted = params;
    },
  });

  const response = await request(app)
    .post('/api/contributions?ref=a1b2c3d4')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', amount: '100', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(submitted.referralLinkId, 'link-1');
  assert.equal(submitted.referralLinkCode, 'a1b2c3d4');
});

test('POST /api/contributions?ref=CODE returns 404 INVALID_REFERRAL_CODE for another campaign\'s code', async () => {
  const app = buildApp({
    resolveReferralLink: async () => {
      const err = new Error('Referral code is not valid for this campaign');
      err.statusCode = 404;
      err.code = 'INVALID_REFERRAL_CODE';
      throw err;
    },
  });

  const response = await request(app)
    .post('/api/contributions?ref=notmine1')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', amount: '100', send_asset: 'XLM' });

  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'INVALID_REFERRAL_CODE');
});

test('POST /api/contributions without ?ref stays unattributed', async () => {
  let submitted;
  let resolveCalled = false;
  const app = buildApp({
    resolveReferralLink: async () => {
      resolveCalled = true;
      return null;
    },
    onSubmit: (params) => {
      submitted = params;
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', amount: '100', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(resolveCalled, false);
  assert.equal(submitted.referralLinkId, null);
  assert.equal(submitted.referralLinkCode, null);
});
