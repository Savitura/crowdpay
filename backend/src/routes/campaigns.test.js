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
      buildBatchRefundTransaction: async () => 'unsigned-refund-xdr',
      signTransactionXdr: ({ xdr }) => xdr + '-signed',
      submitPreparedTransaction: async () => 'refund-tx-hash',
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (enc, opts, fn) => fn('DECRYPTED_SECRET'),
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

test('POST /api/campaigns returns 500 and logs orphaned wallet when DB insert fails', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ email: 'creator@test.com', wallet_public_key: 'GCREATOR', kyc_status: 'verified' }] };
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO campaigns')) {
        throw new Error('unique constraint violation');
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Broken campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 500);
  assert.match(response.body.error, /contact support/i);
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

test('POST /api/campaigns returns 400 for past deadline', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ email: 'creator@test.com', wallet_public_key: 'GCREATOR', kyc_status: 'verified' }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const pastDeadline = yesterday.toISOString().split('T')[0];

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Old deadline', target_amount: '100', asset_type: 'USDC', deadline: pastDeadline });

  assert.equal(response.status, 400);
  assert.ok(Array.isArray(response.body.errors) || response.body.error);
  assert.ok(
    (response.body.errors || []).some((error) => String(error.msg || error).toLowerCase().includes('deadline must be in the future')) ||
    String(response.body.error).toLowerCase().includes('deadline must be a future date')
  );
});

test('GET /api/campaigns/:id/widget returns public CORS widget data', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      assert.match(text, /SELECT c\.title, c\.raised_amount, c\.target_amount/i);
      assert.deepEqual(params, ['campaign-1']);
      return {
        rows: [
          {
            title: 'Solar panels',
            raised_amount: '75',
            target_amount: '100',
            asset_type: 'USDC',
            status: 'active',
            contributor_count: 3,
          },
        ],
      };
    },
  });

  const response = await request(app).get('/api/campaigns/campaign-1/widget');

  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.deepEqual(response.body, {
    title: 'Solar panels',
    raised_amount: '75',
    target_amount: '100',
    asset_type: 'USDC',
    status: 'active',
    contributor_count: 3,
  });
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
  assert.match(listQuery.text, /search_vector @@ plainto_tsquery/i);
  assert.match(listQuery.text, /ts_rank\(c\.search_vector/i);
  assert.match(listQuery.text, /c\.created_at DESC/);
  assert.doesNotMatch(listQuery.text, /raised_amount \/ NULLIF/i);
  assert.ok(listQuery.params.includes('solar'));
  assert.ok(listQuery.params.includes('USDC'));
});

// Campaign Webhooks Tests

test('POST /api/campaigns/:id/webhooks registers a campaign webhook', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('COUNT(*)')) {
        return { rows: [{ count: 2 }] };
      }
      if (text.includes('INSERT INTO campaign_webhooks')) {
        return {
          rows: [{
            id: 'wh-1',
            campaign_id: 'campaign-1',
            url: 'https://example.com/webhook',
            events: ['contribution.indexed'],
            created_at: '2026-06-02T00:00:00Z'
          }]
        };
test('POST /api/campaigns/:id/refund/initiate builds unsigned XDR and initiates refund', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM campaigns') || text.includes('SELECT creator_id')) {
        return { rows: [{ id: 'camp-1', creator_id: 'creator-1', wallet_public_key: 'GPK', status: 'failed', refund_initiated_at: null }] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ id: 'contrib-1', sender_public_key: 'GSENDER', amount: '10.0', asset: 'XLM' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/campaign-1/webhooks')
    .set('Authorization', 'Bearer token')
    .send({
      url: 'https://example.com/webhook',
      events: ['contribution.indexed']
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'wh-1');
  assert.equal(response.body.url, 'https://example.com/webhook');
  assert.ok(response.body.secret);
  assert.ok(response.body.message.includes('Store the signing secret'));
});

test('POST /api/campaigns/:id/webhooks rejects invalid URLs', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/campaign-1/webhooks')
    .set('Authorization', 'Bearer token')
    .send({ url: 'http://example.com' }); // HTTP, not HTTPS

  assert.equal(response.status, 400);
  assert.match(response.body.error, /https/i);
});

test('POST /api/campaigns/:id/webhooks enforces 5 webhook limit', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('COUNT(*)')) {
        return { rows: [{ count: 5 }] }; // Already at limit
    .post('/api/campaigns/camp-1/refund/initiate')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.unsigned_xdr, 'unsigned-refund-xdr');
  const updateQuery = queries.find((q) => q.text.includes('UPDATE campaigns') && q.text.includes('refund_xdr'));
  assert.ok(updateQuery);
  assert.equal(updateQuery.params[0], 'unsigned-refund-xdr');
});

test('POST /api/campaigns/:id/refund/approve/creator signs refund XDR as creator', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM campaigns') || text.includes('SELECT creator_id')) {
        return { rows: [{ id: 'camp-1', creator_id: 'creator-1', refund_xdr: 'unsigned-refund-xdr', status: 'failed' }] };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'ENC', wallet_public_key: 'GCREATOR', wallet_type: 'custodial' }] };
test('GET /api/campaigns uses plainto_tsquery for multi-word search', async () => {
test('GET /api/campaigns supports sort=trending with CTE query', async () => {
test('GET /api/campaigns/categories returns category counts', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      return {
        rows: [
          { category: 'technology', count: '5' },
          { category: 'education', count: '3' },
        ],
      };
    },
  });

  const response = await request(app).get('/api/campaigns/categories');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [
    { category: 'technology', count: '5' },
    { category: 'education', count: '3' },
  ]);
});

test('GET /api/campaigns supports category filter', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/campaign-1/webhooks')
    .set('Authorization', 'Bearer token')
    .send({ url: 'https://example.com/webhook' });

  assert.equal(response.status, 429);
  assert.match(response.body.error, /limit/i);
});

test('GET /api/campaigns/:id/webhooks lists webhooks for campaign', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT id, url, events, active')) {
        return {
          rows: [{
            id: 'wh-1',
            url: 'https://example.com/webhook',
            events: ['contribution.indexed'],
            active: true,
            created_at: '2026-06-02T00:00:00Z',
            secret_hint: '1234567890…cdef'
          }]
        };
    .post('/api/campaigns/camp-1/refund/approve/creator')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.signed_xdr, 'unsigned-refund-xdr-signed');
  const updateQuery = queries.find((q) => q.text.includes('UPDATE campaigns') && q.text.includes('refund_xdr'));
  assert.ok(updateQuery);
  assert.equal(updateQuery.params[0], 'unsigned-refund-xdr-signed');
});

test('POST /api/campaigns/:id/refund/approve/platform signs and submits refund to Stellar', async () => {
  const originalApprover = process.env.PLATFORM_APPROVER_USER_ID;
  process.env.PLATFORM_APPROVER_USER_ID = 'admin-1';
  
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'admin-1', role: 'admin' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM campaigns')) {
        return { rows: [{ id: 'camp-1', wallet_public_key: 'GPK', refund_xdr: 'unsigned-refund-xdr-signed', status: 'failed' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/webhooks')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].id, 'wh-1');
  assert.ok(response.body[0].secret_hint.includes('…'));
});

test('DELETE /api/campaigns/:id/webhooks/:wid disables a webhook', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('UPDATE campaign_webhooks')) {
        return { rows: [{ id: 'wh-1' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .delete('/api/campaigns/campaign-1/webhooks/wh-1')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.revoked, true);
  assert.equal(response.body.id, 'wh-1');
});

test('GET /api/campaigns/:id/webhooks/:wid/deliveries shows delivery history', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id FROM campaigns WHERE id = $1')) {
        return { rows: [{ id: 'campaign-1' }] };
      }
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT id FROM campaign_webhooks')) {
        return { rows: [{ id: 'wh-1' }] };
      }
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }] };
      }
      if (text.includes('SELECT id, event, status')) {
        return {
          rows: [{
            id: 'del-1',
            event: 'contribution.indexed',
            status: 'delivered',
            response_status: 200,
            attempt_count: 1,
            last_error: null,
            delivered_at: '2026-06-02T10:30:00Z',
            failed_at: null,
            created_at: '2026-06-02T10:29:00Z',
            updated_at: '2026-06-02T10:30:00Z'
          }]
    .post('/api/campaigns/camp-1/refund/approve/platform')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.tx_hash, 'refund-tx-hash');

  const updateCampQuery = queries.find((q) => q.text.includes('UPDATE campaigns') && q.text.includes('refunded'));
  assert.ok(updateCampQuery);
  assert.equal(updateCampQuery.params[0], 'refund-tx-hash');

  const updateContribQuery = queries.find((q) => q.text.includes('UPDATE contributions') && q.text.includes('refunded = TRUE'));
  assert.ok(updateContribQuery);

  process.env.PLATFORM_APPROVER_USER_ID = originalApprover;
});
  const response = await request(app).get(
    '/api/campaigns?search=clean%20energy%20project'
  );

  assert.equal(response.status, 200);
  const listQuery = queries.find((q) => q.text.includes('plainto_tsquery'));
  assert.ok(listQuery);
  assert.ok(listQuery.params.includes('clean energy project'));
});
      if (text.includes('COUNT(*)::int AS total')) {
      if (text.includes('AS total')) {
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
            recentContributions: 3,
            recent_contributions: 3,
            recent_volume: 150,
            trending_score: 380,
          },
        ],
      };
    },
  });

  const response = await request(app).get('/api/campaigns?sort=trending');

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.campaigns.length, 1);
  assert.equal(response.body.campaigns[0].recentContributions, 3);
  
  const listQuery = queries.find((q) => q.text.includes('WITH recent AS'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /ORDER BY trending_score DESC/i);
});
            category: 'technology',
          },
        ],
      };
    },
  });

  const response = await request(app).get('/api/campaigns?category=technology');

  assert.equal(response.status, 200);
  assert.equal(response.body.campaigns[0].category, 'technology');
  const listQuery = queries.find((q) => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /category = \$/i);
  assert.ok(listQuery.params.includes('technology'));
});

test('POST /api/campaigns accepts valid category', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';

  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'unverified' }] };
      }
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Tech campaign',
              asset_type: 'USDC',
              creator_id: 'creator-1',
              category: 'technology',
test('GET /api/campaigns/:id/clone-data returns clone-ready details', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'c-1',
              title: 'Original Campaign',
              description: 'My description',
              target_amount: '100.0000000',
              asset_type: 'USDC',
              min_contribution: '5.0000000',
              max_contribution: '50.0000000',
              show_backer_amounts: true,
              deleted_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/webhooks/wh-1/deliveries')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.deliveries.length, 1);
  assert.equal(response.body.deliveries[0].status, 'delivered');
  assert.equal(response.body.deliveries[0].response_status, 200);
});
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Tech campaign', target_amount: '100', asset_type: 'USDC', category: 'technology' });

  assert.equal(response.status, 201);
  assert.equal(response.body.category, 'technology');
  
  const insertQuery = queries.find((q) => q.text.includes('INSERT INTO campaigns'));
  assert.ok(insertQuery);
  assert.ok(insertQuery.text.includes('category'));
  assert.ok(insertQuery.params.includes('technology'));
});

test('POST /api/campaigns rejects invalid category', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
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
    .send({ title: 'Tech campaign', target_amount: '100', asset_type: 'USDC', category: 'invalid_category' });

  assert.equal(response.status, 400);
  assert.ok(response.body.errors);
  assert.ok(response.body.errors.some(e => e.msg && e.msg.includes('category must be one of')));
  });

  const response = await request(app)
    .get('/api/campaigns/c-1/clone-data')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'Original Campaign (copy)');
  assert.equal(response.body.description, 'My description');
  assert.equal(response.body.target_amount, '100.0000000');
  assert.equal(response.body.asset_type, 'USDC');
  assert.equal(response.body.min_contribution, '5.0000000');
  assert.equal(response.body.max_contribution, '50.0000000');
  assert.equal(response.body.show_backer_amounts, true);
  assert.equal(response.body.deadline, undefined);
});

test('GET /api/campaigns/:id/clone-data returns 404 for missing campaign', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const response = await request(app)
    .get('/api/campaigns/c-none/clone-data')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 404);
});

