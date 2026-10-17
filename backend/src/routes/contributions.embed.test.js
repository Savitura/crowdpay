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
    '../services/embedTokenJwtService': {
      verifyEmbedToken: verifyJwtImpl || (() => null),
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
    },
    '../services/kycService': {
      assertUserKycVerified: async () => true,
    },
    '../services/contributorIdentityService': {
      assertContributorMeetsRequirements: async () => true,
    },
    '../services/contributionPolicy': {
      assertContributionPolicy: async () => true,
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
