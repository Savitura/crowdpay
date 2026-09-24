const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

if (!process.env.PLATFORM_SECRET_KEY) {
  process.env.PLATFORM_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.USDC_ISSUER) {
  process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
}
if (!process.env.STELLAR_NETWORK) {
  process.env.STELLAR_NETWORK = 'testnet';
}
if (!process.env.STELLAR_HORIZON_URL) {
  process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret';
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
}

function buildApp({ queryImpl, authUser }) {
  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds: async () => ({ refundsCreated: 0, refunds: [] }),
    },
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: async () => '',
    },
    '../services/ledgerMonitor': { watchCampaignWallet: async () => {} },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => 'tx-row',
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../services/sorobanService': {
      deployCampaignContracts: async () => ({
        escrowContractId: 'C' + 'A'.repeat(55),
        milestonesContractId: 'C' + 'B'.repeat(55),
      }),
      invokeContract: async () => null,
      encodeMilestone: () => ({
        title_hash: Buffer.alloc(32),
        release_bps: 1000,
        status: 0,
        evidence_hash: null,
      }),
      nativeToScVal: (v) => v,
      scvAddressFromString: (s) => s,
    },
    '../services/emailService': { sendEmail: async () => {} },
    '../services/alerting': { sendAlert: () => {} },
    '../services/walletService': { encryptSecret: () => 'encrypted-secret' },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      WEBHOOK_EVENTS: {
        CAMPAIGN_CREATED: 'campaign.created',
        CAMPAIGN_FUNDED: 'campaign.funded',
        CAMPAIGN_FAILED: 'campaign.failed',
      },
    },
    '../services/storage': { uploadCampaignCoverImage: async () => '/images/cover.jpg' },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
    },
    '../services/userDashboardService': { listCreatorCampaigns: async () => [] },
    '../services/campaignAnalyticsService': {
      getCampaignAnalytics: async () => ({}),
      getCampaignContributors: async () => ({}),
    },
    '../middleware/validation': {
      createCampaignValidation: [],
      createCampaignUpdateValidation: [],
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
    '../utils/asyncHandler': (fn) => (req, res, next) => fn(req, res, next).catch(next),
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser || { userId: 'user-1', role: 'creator' };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
      optionalAuth: (req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/campaigns', router);
  return app;
}

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';

const CAMPAIGN_ROW = {
  id: CAMPAIGN_ID,
  title: 'Clean Water Initiative',
  description: 'Provide clean drinking water to remote villages',
  target_amount: '5000',
  raised_amount: '2500',
  asset_type: 'USDC',
  status: 'active',
  deleted_at: null,
  is_hidden: false,
  creator_id: 'user-1',
  creator_name: 'Jane Doe',
  creator_email: 'jane@example.com',
};

test('GET /api/campaigns/:id/og-image.png returns 200 with image/png and valid PNG header', async () => {
  const app = buildApp({
    queryImpl: async (sql, _params) => {
      if (sql.includes('FROM campaigns c') && sql.includes('WHERE c.id = $1')) {
        return { rows: [CAMPAIGN_ROW] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/og-image.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.body[0], 0x89);
  assert.equal(res.body[1], 0x50);
  assert.equal(res.body[2], 0x4e);
  assert.equal(res.body[3], 0x47);
});

test('GET /api/campaigns/:id/og-image alias returns 200 with image/png', async () => {
  const app = buildApp({
    queryImpl: async (sql, _params) => {
      if (sql.includes('FROM campaigns c') && sql.includes('WHERE c.id = $1')) {
        return { rows: [CAMPAIGN_ROW] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/og-image`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
});

test('GET /api/campaigns/:id/og-image.png returns 404 when campaign not found', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/og-image.png`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Campaign not found');
});

test('GET /api/campaigns/:id includes og_image_url and share_url', async () => {
  const app = buildApp({
    queryImpl: async (sql, _params) => {
      if (sql.includes('FROM campaigns c') && sql.includes('JOIN users u')) {
        return { rows: [CAMPAIGN_ROW] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.og_image_url);
  assert.ok(res.body.og_image_url.includes(`/api/campaigns/${CAMPAIGN_ID}/og-image.png`));
  assert.ok(res.body.share_url);
  assert.ok(res.body.share_url.includes(`/campaigns/${CAMPAIGN_ID}`));
});

test('GET /api/campaigns/:id with ?source=twitter sets cp_share_source cookie', async () => {
  const app = buildApp({
    queryImpl: async (sql, _params) => {
      if (sql.includes('FROM campaigns c') && sql.includes('JOIN users u')) {
        return { rows: [CAMPAIGN_ROW] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}?source=twitter`);
  assert.equal(res.status, 200);
  const cookies = res.headers['set-cookie'] || [];
  const shareCookie = cookies.find((c) => c.startsWith(`cp_share_source_${CAMPAIGN_ID}`));
  assert.ok(shareCookie, 'cp_share_source cookie should be set');
  assert.ok(shareCookie.includes('twitter'));
});
