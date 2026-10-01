'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-contributions-embed-32';
process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function buildApp({ queryImpl, verifyJwtImpl, validateDbTokenImpl }) {
  const router = proxyquire('./contributions', {
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: async () => {}, release: async () => {} }),
    },
    '../config/stellar': {
      networkPassphrase: 'Test SDF Network ; September 2015',
      isTestnet: true,
    },
    '../config/logger': {
      error: () => {},
      info: () => {},
      warn: () => {},
    },
    '../services/embedTokenJwtService': {
      extractEmbedToken: req => req.headers.authorization?.replace('Bearer ', ''),
      verifyEmbedToken: verifyJwtImpl || (() => null),
      signEmbedToken: () => 'stub-token',
    },
    '../services/embedTokenService': {
      validateEmbedToken: validateDbTokenImpl || (async () => null),
    },
    '../services/contributionService': {
      submitCustodialContribution: async () => ({
        txHash: 'abc123hash',
        conversionQuote: null,
        platformFeeAmount: 0,
      }),
      buildContributionMemo: () => 'cp-c-1',
      buildAttributionMemo: () => 'cp-c-1',
    },
    '../services/stellarService': {
      buildUnsignedContributionPayment: async () => 'unsigned-xdr',
      buildUnsignedContributionPathPayment: async () => 'unsigned-xdr',
      submitPreparedTransaction: async () => 'tx-hash',
      getPathPaymentQuote: async () => [],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
    '../services/sorobanService': {
      triggerRefund: async () => null,
      isContractDepositEligible: () => false,
      buildUnsignedEscrowDeposit: async () => 'soroban-xdr',
    },
    '../services/ledgerMonitor': {
      recordConfirmedContribution: async () => {},
    },
    '../services/pathPaymentPreview': {
      consumeContributionPreview: async () => null,
    },
    '../services/contributionDiagnostics': {
      diagnoseContribution: async () => ({}),
      STATUS_PENDING: 'pending',
    },
    '../services/referral': {
      resolveReferralLink: async () => null,
    },
    '../services/referralService': {
      getReferralCodeFromRequest: () => null,
    },
    '../services/rewardTierService': {
      reserveTierSlot: async () => true,
      reserveInventory: async () => true,
      claimInventory: async () => true,
      releaseInventory: async () => true,
      createFulfillment: async () => ({}),
    },
    '../services/kycService': {
      assertUserKycVerified: async () => true,
    },
    '../services/contributorIdentityService': {
      assertContributorMeetsRequirements: async () => true,
    },
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
    '../middleware/contributionRateLimiter': {
      contributionRateLimiter: (_req, _res, next) => next(),
    },
    '../utils/pagination': {
      parsePagination: (query, defaults = {}) => {
        const limit = Math.min(
          Math.max(parseInt(query.limit, 10) || defaults.limit || 20, 1),
          defaults.max || 100
        );
        const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
        return { limit, offset };
      },
      paginatedResponse: async (db, countSql, dataSql, baseParams, limit, offset) => {
        const countResult = await db.query(countSql, baseParams);
        const total = parseInt(countResult.rows[0]?.total ?? '0', 10);
        const dataResult = await db.query(dataSql, [...baseParams, limit, offset]);
        return { data: dataResult.rows, total, limit, offset };
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contributions', router);
  return app;
}

test('POST /api/contributions/embed returns 401 for missing embed token', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
  const res = await request(app)
    .post('/api/contributions/embed')
    .send({ campaign_id: 'c-1', amount: '100' });
  assert.equal(res.status, 401);
});

test('POST /api/contributions/embed returns 401 for invalid JWT token', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    verifyJwtImpl: () => null,
  });
  const res = await request(app)
    .post('/api/contributions/embed')
    .send({ campaign_id: 'c-1', amount: '100', embed_token: 'bad-token' });
  assert.equal(res.status, 401);
});

test('POST /api/contributions/embed returns 403 for mismatched campaign token', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    verifyJwtImpl: () => ({ sub: 'c-other', user_id: 'u-1' }),
  });
  const res = await request(app)
    .post('/api/contributions/embed')
    .send({ campaign_id: 'c-1', amount: '100', embed_token: 'valid-jwt-other-campaign' });
  assert.equal(res.status, 403);
});

test('POST /api/contributions/embed succeeds with valid token and active campaign', async () => {
  const queryImpl = async sql => {
    if (sql.includes('FROM campaigns')) {
      return {
        rows: [
          {
            id: 'c-1',
            title: 'Test Campaign',
            asset_type: 'XLM',
            status: 'active',
            wallet_public_key: 'GCPK',
            escrow_contract_id: null,
          },
        ],
      };
    }
    if (sql.includes('FROM users')) {
      return {
        rows: [
          {
            wallet_public_key: 'GCONTRIB',
            wallet_secret_encrypted: 'ENC',
          },
        ],
      };
    }
    return { rows: [] };
  };

  const app = buildApp({
    queryImpl,
    verifyJwtImpl: () => ({ sub: 'c-1', user_id: 'u-1' }),
    validateDbTokenImpl: async () => ({ id: 'token-1', user_id: 'u-1', campaign_id: 'c-1' }),
  });

  const res = await request(app)
    .post('/api/contributions/embed')
    .send({ campaign_id: 'c-1', amount: '50', embed_token: 'valid-jwt' });
  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);
});

test('POST /api/contributions/embed returns 401 for revoked db-backed embed token', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    verifyJwtImpl: () => ({ sub: 'c-1', user_id: 'u-1' }),
    validateDbTokenImpl: async () => null,
  });

  const res = await request(app)
    .post('/api/contributions/embed')
    .send({ campaign_id: 'c-1', amount: '50', embed_token: 'cped_revokedtoken123456789' });
  assert.equal(res.status, 401);
});
