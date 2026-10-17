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
      nativeToScVal: v => v,
      scvAddressFromString: s => s,
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
      updateCampaignValidation: [],
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
      // campaigns.js calls createValidateRequest(422) at module load.
      createValidateRequest: () => (_req, _res, next) => next(),
    },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
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
  title: 'Solar grid',
  description: 'Community owned solar',
  target_amount: '1000',
  raised_amount: '400',
  asset_type: 'USDC',
  status: 'active',
  deadline: null,
  backer_count: 12,
};

const MILESTONE_ROWS = [
  { id: 'm-1', title: 'Design', release_percentage: '25', sort_order: 0, status: 'released' },
  { id: 'm-2', title: 'Build', release_percentage: '25', sort_order: 1, status: 'approved' },
  {
    id: 'm-3',
    title: 'Install',
    release_percentage: '25',
    sort_order: 2,
    status: 'pending_review',
  },
  { id: 'm-4', title: 'Handover', release_percentage: '25', sort_order: 3, status: 'rejected' },
];

function embedQuery({
  campaignRows = [CAMPAIGN_ROW],
  milestoneRows = MILESTONE_ROWS,
  backerRows = [],
} = {}) {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('FROM contributions ctr')) return { rows: backerRows };
    if (text.includes('FROM milestones')) return { rows: milestoneRows };
    if (text.includes('FROM campaigns WHERE id = $1')) return { rows: campaignRows };
    return { rows: [] };
  };
  return { queryImpl, calls };
}

test('GET /api/campaigns/:id/embed includes milestones with public statuses', async () => {
  const { queryImpl, calls } = embedQuery();
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed`);

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.milestones.map(milestone => milestone.status),
    ['released', 'approved', 'submitted', 'pending']
  );
  assert.deepEqual(res.body.milestones[0], {
    id: 'm-1',
    title: 'Design',
    release_percentage: 25,
    sort_order: 0,
    status: 'released',
  });
  // The campaign id must reach the query untouched — it is a UUID, not an int.
  const campaignLookup = calls.find(call => call.text.includes('FROM campaigns WHERE id = $1'));
  assert.deepEqual(campaignLookup.params, [CAMPAIGN_ID]);
});

test('GET /api/campaigns/:id/embed summarises milestone progress', async () => {
  const { queryImpl } = embedQuery();
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed`);

  assert.deepEqual(res.body.milestone_summary, {
    total: 4,
    released: 1,
    approved: 1,
    submitted: 1,
    pending: 1,
    released_percentage: 25,
  });
});

test('GET /api/campaigns/:id/widget carries the same milestone payload', async () => {
  const { queryImpl } = embedQuery();
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/widget`);

  assert.equal(res.status, 200);
  assert.equal(res.body.milestones.length, 4);
  assert.equal(res.body.milestone_summary.released, 1);
  assert.equal(res.body.contributor_count, 12);
});

test('GET /api/campaigns/:id/widget includes the public description and cache header', async () => {
  const longDescription = 'x'.repeat(260);
  const { queryImpl } = embedQuery({
    campaignRows: [{ ...CAMPAIGN_ROW, description: longDescription }],
  });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/widget`);

  assert.equal(res.status, 200);
  assert.equal(res.body.description.length, 203);
  assert.ok(res.body.description.endsWith('...'));
  assert.equal(res.headers['cache-control'], 'public, max-age=30');
});

test('GET /api/campaigns/:id/widget lists recently named backers', async () => {
  const { queryImpl } = embedQuery({
    backerRows: [
      { display_name: 'Alice', amount: '250', contributor_privacy: 'full' },
      { display_name: 'Bob', amount: '75', contributor_privacy: 'amount_only' },
    ],
  });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/widget`);

  assert.deepEqual(res.body.recent_backers, [
    { name: 'Alice', amount: 250 },
    // amount_only contributors keep their amount but never their name
    { name: 'Anonymous', amount: 75 },
  ]);
});

test('GET /api/campaigns/:id/widget never names anonymous backers', async () => {
  const { queryImpl } = embedQuery({
    backerRows: [
      { display_name: 'Carol', amount: '40', contributor_privacy: 'anonymous' },
      { display_name: 'Dave', amount: '10', contributor_privacy: 'anonymous' },
    ],
  });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/widget`);

  // Anonymous backers are neither named nor counted in the public strip.
  assert.deepEqual(res.body.recent_backers, []);
});

test('GET /api/campaigns/:id/widget hides amounts when the campaign opted out', async () => {
  const { queryImpl } = embedQuery({
    campaignRows: [{ ...CAMPAIGN_ROW, show_backer_amounts: false }],
    backerRows: [{ display_name: 'Alice', amount: '250', contributor_privacy: 'full' }],
  });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/widget`);

  assert.deepEqual(res.body.recent_backers, [{ name: 'Alice', amount: null }]);
});

test('GET /api/campaigns/:id/widget returns no backers when none exist', async () => {
  const { queryImpl } = embedQuery({ backerRows: [] });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/widget`);

  assert.deepEqual(res.body.recent_backers, []);
});

test('GET /api/campaigns/:id/embed returns an empty milestone list for campaigns without a plan', async () => {
  const { queryImpl } = embedQuery({ milestoneRows: [] });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed`);

  assert.deepEqual(res.body.milestones, []);
  assert.deepEqual(res.body.milestone_summary, {
    total: 0,
    released: 0,
    approved: 0,
    submitted: 0,
    pending: 0,
    released_percentage: 0,
  });
});

test('GET /api/campaigns/:id/embed 404s for a hidden or missing campaign', async () => {
  const { queryImpl } = embedQuery({ campaignRows: [] });
  const app = buildApp({ queryImpl });

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/embed`);

  assert.equal(res.status, 404);
});
