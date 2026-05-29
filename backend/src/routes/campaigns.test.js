const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({
  queryImpl,
  buildWithdrawalTransactionImpl,
  insertWithdrawalPendingSignaturesImpl,
  authUser,
  campaignStatusImpl,
}) {
  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': campaignStatusImpl || {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: buildWithdrawalTransactionImpl,
    },
    '../services/ledgerMonitor': {
      watchCampaignWallet: async () => {},
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: insertWithdrawalPendingSignaturesImpl,
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser || { userId: 'platform-1', role: 'admin' };
        next();
      },
      requireRole: () => (req, _res, next) => {
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

test('POST /api/campaigns/cron/fail-expired returns failed and funded campaigns', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
    campaignStatusImpl: {
      refreshActiveCampaignStatuses: async () => ({
        failed: [{
          id: 'c-1',
          title: 'Campaign 1',
          target_amount: '100',
          raised_amount: '50',
          deadline: '2026-04-23',
          status: 'failed',
        }],
        funded: [{ id: 'c-2', title: 'Funded', status: 'funded' }],
      }),
    },
  });

  const response = await request(app)
    .post('/api/campaigns/cron/fail-expired')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.failedCampaigns.length, 1);
  assert.equal(response.body.fundedCampaigns.length, 1);
});

test('POST /api/campaigns blocks unverified creators when KYC gate is enabled', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'pending' }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Verified only', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'KYC_REQUIRED');
});

test('POST /api/campaigns allows creation when KYC gate is disabled', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'unverified' }] };
      }
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Dev campaign',
              asset_type: 'USDC',
              creator_id: 'creator-1',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Dev campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'campaign-1');
});

test('POST /api/campaigns returns 400 with validation errors for invalid payload', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: '', target_amount: -5, asset_type: 'INVALID' });

  assert.equal(response.status, 400);
  assert.ok(Array.isArray(response.body.errors));
  assert.ok(response.body.errors.length >= 1);
});

test('POST /api/campaigns/:id/trigger-refunds creates refund requests for contributions', async () => {
  const created = [];
  const queryImpl = async (text, params) => {
    if (text.includes('SELECT id, wallet_public_key, status FROM campaigns')) {
      return { rows: [{ id: 'c-1', wallet_public_key: 'GPK', status: 'failed' }] };
    }
    if (text.includes('FROM contributions c')) {
      return {
        rows: [
          {
            id: 'contrib-1',
            campaign_id: 'c-1',
            sender_public_key: 'GSENDER',
            amount: '15.0000000',
            asset: 'USDC',
            payment_type: 'payment',
            source_amount: null,
            source_asset: null,
            conversion_rate: null,
            path: null,
            tx_hash: 'tx-1',
            created_at: '2026-04-23T12:00:00Z',
          },
        ],
      };
    }
    if (text.includes('INSERT INTO withdrawal_requests')) {
      return { rows: [{ id: 'wr-1' }] };
    }
    return { rows: [] };
  };

  const app = buildApp({
    queryImpl,
    buildWithdrawalTransactionImpl: async () => 'unsigned-xdr',
    insertWithdrawalPendingSignaturesImpl: async (client, { withdrawalRequestId }) => {
      created.push(withdrawalRequestId);
      return 'stellar-row-id';
    },
  });

  const response = await request(app)
    .post('/api/campaigns/c-1/trigger-refunds')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 201);
  assert.equal(response.body.refundsCreated, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0], 'wr-1');
});

test('GET /api/campaigns supports search, asset filter, and sort', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          {
            id: 'camp-1',
            title: 'Solar panels',
            description: 'Clean energy',
            asset_type: 'USDC',
            status: 'active',
            raised_amount: '80',
            target_amount: '100',
          },
        ],
      };
    },
  });

  const response = await request(app).get(
    '/api/campaigns?search=solar&asset=USDC&sort=closest_to_goal'
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.campaigns.length, 1);
  const listQuery = queries.find((q) => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /ILIKE/i);
  assert.match(listQuery.text, /raised_amount \/ NULLIF/i);
  assert.ok(listQuery.params.includes('%solar%'));
  assert.ok(listQuery.params.includes('USDC'));
});
