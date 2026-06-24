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
    },
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/campaigns', router);
  return app;
}

test('GET /api/campaigns/:id/referral returns existing referral code', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaign_referrals cr')) {
        return {
          rows: [{
            id: 'ref-1',
            referral_code: 'stable12',
            click_count: 3,
            contribution_count: 1,
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/camp-1/referral')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.referral_code, 'stable12');
  assert.match(response.body.referral_url, /ref=stable12/);
  assert.equal(response.body.click_count, 3);
  assert.equal(response.body.contribution_count, 1);
});

test('GET /api/campaigns/:id/referral creates a new referral code', async () => {
  const calls = [];
  const app = buildApp({
    queryImpl: async (text) => {
      calls.push(text);
      if (text.includes('FROM campaign_referrals cr') && text.includes('referrer_user_id')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO campaign_referrals')) {
        return {
          rows: [{
            referral_code: 'newcode1',
            click_count: 0,
            contribution_count: 0,
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/camp-1/referral')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 201);
  assert.equal(response.body.referral_code, 'newcode1');
  assert.ok(calls.some((text) => text.includes('INSERT INTO campaign_referrals')));
});

test('GET /api/campaigns/:id?ref=CODE increments click count and sets cookie', async () => {
  const calls = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      calls.push({ text, params });
      if (text.includes('campaign_referrals WHERE referral_code')) {
        return { rows: [{ id: 'ref-1', campaign_id: 'camp-1' }] };
      }
      if (text.includes('click_count = click_count + 1')) {
        return { rows: [] };
      }
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: 'camp-1',
            title: 'Test',
            description: 'Desc',
            target_amount: '100',
            raised_amount: '0',
            asset_type: 'XLM',
            status: 'active',
            creator_id: 'creator-1',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app).get('/api/campaigns/camp-1?ref=abc12345');

  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call.text.includes('click_count = click_count + 1')));
  const cookie = response.headers['set-cookie']?.find((value) => value.startsWith('cp_ref_camp-1='));
  assert.ok(cookie);
  assert.match(cookie, /abc12345/);
});

test('GET /api/campaigns/:id/referrals returns leaderboard for owner', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_referrals cr') && text.includes('JOIN users')) {
        return {
          rows: [{
            referral_code: 'topref01',
            click_count: 10,
            contribution_count: 2,
            created_at: '2026-06-01T00:00:00.000Z',
            referrer_name: 'Alice',
            referrer_id: 'user-2',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/camp-1/referrals')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].referrer_name, 'Alice');
  assert.equal(response.body[0].contribution_count, 2);
});
