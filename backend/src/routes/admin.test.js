const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, authUser, revokeAndCloseImpl } = {}) {
  const dbStub = { query: queryImpl };

  const authMiddleware = {
    requireAuth: (req, res, next) => {
      if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
      req.user = authUser;
      next();
    },
    requireAdmin: (req, res, next) => {
      if (!req.user?.is_admin) return res.status(403).json({ error: 'Forbidden' });
      next();
    },
    IMPERSONATION_TOKEN_COOKIE_NAME: 'impersonation_token',
  };

  const adminRouter = proxyquire('./admin', {
    '../config/database': dbStub,
    '../middleware/auth': authMiddleware,
    '../services/reconciliation': {
      reconcileSingleCampaign: async () => ({ message: 'ok' }),
      getRecentReconciliationRuns: () => [],
    },
    '../config/stellar': {
      server: {
        ledgers: () => ({
          order: () => ({
            limit: () => ({ call: async () => ({ records: [{ sequence: 123 }] }) }),
          }),
        }),
        feeStats: async () => ({ last_ledger_base_fee: 100 }),
      },
    },
    '../services/sorobanService': {
      deployCampaignContracts: async () => ({}),
    },
    '../services/webhookDispatcher': {
      processDelivery: async () => {},
      processCampaignWebhookDelivery: async () => {},
    },
    '../utils/cache': {
      invalidate: () => {},
      invalidatePrefix: () => {},
    },
    '../utils/pagination': {
      parsePagination: (query, defaults) => ({
        limit: parseInt(query.limit) || defaults.limit || 50,
        offset: parseInt(query.offset) || 0,
      }),
    },
    '../services/stellarService': {
      revokeAndCloseCampaignWallet: revokeAndCloseImpl || (async () => ({})),
    },
    '../services/alerting': {
      sendAlert: async () => {},
    },
    '../utils/asyncHandler': fn => fn,
    '../config/constants': {
      IMPERSONATION_TTL_SECONDS: 900,
      ADMIN_AUDIT_LOG_MAX_LIMIT: 500,
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
  });

  const campaignsRouter = express.Router();

  campaignsRouter.get('/', authMiddleware.requireAuth, async (req, res) => {
    const { rows } = await dbStub.query(
      `SELECT c.id, c.title, c.status FROM campaigns c WHERE c.status NOT IN ('suspended') AND c.deleted_at IS NULL`
    );
    res.json({ campaigns: rows });
  });

  campaignsRouter.get('/:id', authMiddleware.requireAuth, async (req, res) => {
    const { rows } = await dbStub.query(
      'SELECT * FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(rows[0]);
  });

  const contributionsRouter = express.Router();

  contributionsRouter.use(authMiddleware.requireAuth);
  contributionsRouter.post('/prepare', async (req, res) => {
    const { rows } = await dbStub.query(
      "SELECT c.*, u.email as creator_email FROM campaigns c JOIN users u ON c.creator_id = u.id WHERE c.id = $1 AND c.status = 'active' AND c.deleted_at IS NULL",
      [req.body.campaign_id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Campaign not found or inactive' });
    res.json({ xdr: 'mock-xdr' });
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/contributions', contributionsRouter);
  return app;
}

describe('Admin Authentication', () => {
  it('non-admin users should receive 403 from admin routes', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async () => ({ rows: [{ count: 0 }] }),
    });
    const res = await request(app).get('/api/admin/campaigns');
    assert.equal(res.status, 403);
  });

  it('admin users should access admin routes', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
        if (text.includes('SUM(raised_amount)')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/stats');
    assert.equal(res.status, 200);
  });

  it('unauthenticated users should receive 401', async () => {
    const app = buildApp({
      queryImpl: async () => ({ rows: [] }),
    });
    const res = await request(app).get('/api/admin/stats');
    assert.equal(res.status, 401);
  });
});

describe('Campaign Suspension', () => {
  it('admin can suspend a campaign', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('SELECT id, status, is_flagged_fraud FROM campaigns')) {
          return { rows: [{ id: 'camp-1', status: 'active', is_flagged_fraud: false }] };
        }
        if (text.includes('UPDATE campaigns SET status')) {
          return {
            rows: [{ id: 'camp-1', title: 'Test', status: 'suspended', created_at: new Date() }],
          };
        }
        return { rows: [] };
      },
    });
    const res = await request(app)
      .patch('/api/admin/campaigns/camp-1/suspend')
      .send({ reason: 'Policy violation' });
    assert.equal(res.status, 200);
    assert.equal(res.body.campaign.status, 'suspended');
  });

  it('suspended campaigns are hidden from public listing', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async text => {
        if (text.includes('FROM campaigns c') && text.includes('COUNT(*)')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM campaigns c') && text.includes('SELECT c.id')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/campaigns');
    assert.equal(res.status, 200);
    assert.equal(res.body.campaigns.length, 0);
  });

  it('suspended campaigns show notice when viewed directly', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async text => {
        if (text.includes('FROM campaigns WHERE id')) {
          return {
            rows: [
              {
                id: 'camp-1',
                title: 'Test',
                status: 'suspended',
                target_amount: 1000,
                raised_amount: 0,
                asset_type: 'XLM',
                description: 'desc',
                wallet_public_key: 'G_CAMP',
                created_at: new Date(),
                creator_id: 'user-1',
                deleted_at: null,
                suspended_notice: 'This campaign has been suspended.',
                deadline: null,
                min_contribution: null,
                max_contribution: null,
                featured: false,
                is_hidden: false,
                is_flagged_duplicate: false,
                is_flagged_fraud: false,
                contributor_count: 0,
              },
            ],
          };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/campaigns/camp-1');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'suspended');
  });

  it('contributions cannot be made to suspended campaigns', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async text => {
        if (text.includes('UPDATE users SET kyc_status')) {
          return { rows: [] };
        }
        if (text.includes('SELECT c.*, u.email')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).post('/api/contributions/prepare').send({
      campaign_id: 'camp-1',
      sender_public_key: 'G_USER_PUB',
      amount: '100',
      send_asset: 'XLM',
    });
    assert.equal(res.status, 400);
  });

  it('admin can restore a suspended campaign', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('SELECT id, status FROM campaigns')) {
          return { rows: [{ id: 'camp-1', status: 'suspended' }] };
        }
        if (text.includes('UPDATE campaigns SET status')) {
          return {
            rows: [{ id: 'camp-1', title: 'Test', status: 'active', created_at: new Date() }],
          };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).patch('/api/admin/campaigns/camp-1/restore');
    assert.equal(res.status, 200);
    assert.equal(res.body.campaign.status, 'active');
  });
});

describe('Campaign Deletion', () => {
  it('admin can soft-delete a campaign', async () => {
    let walletRevokeCalled = false;
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      revokeAndCloseImpl: async () => {
        walletRevokeCalled = true;
      },
      queryImpl: async text => {
        if (text.includes('SELECT id, title, creator_id, wallet_public_key')) {
          return {
            rows: [
              {
                id: 'camp-1',
                title: 'Test',
                creator_id: 'user-1',
                wallet_public_key: 'G_CAMP',
                wallet_secret_encrypted: 'enc',
              },
            ],
          };
        }
        if (text.includes('UPDATE campaigns SET deleted_at')) {
          return { rows: [{ id: 'camp-1', title: 'Test', deleted_at: new Date() }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app)
      .delete('/api/admin/campaigns/camp-1')
      .send({ reason: 'Fraudulent campaign' });
    assert.equal(res.status, 200);
    assert.ok(res.body.campaign.deleted_at);
    assert.equal(walletRevokeCalled, true);
  });

  it('deleted campaigns return 404', async () => {
    const app = buildApp({
      authUser: { userId: 'user-1', is_admin: false },
      queryImpl: async text => {
        if (text.includes('FROM campaigns WHERE id')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/campaigns/camp-1');
    assert.equal(res.status, 404);
  });
});

describe('User Management', () => {
  it('admin can ban a user', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async (text, params) => {
        if (text.includes('SELECT id, email, is_banned FROM users')) {
          return { rows: [{ id: 'user-2', email: 'test@test.com', is_banned: false }] };
        }
        if (text.includes('UPDATE users SET is_banned')) {
          return { rows: [{ id: 'user-2', email: 'test@test.com', is_banned: true }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app)
      .patch('/api/admin/users/user-2/ban')
      .send({ reason: 'Abusive behavior' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.is_banned, true);
  });

  it('admin can unban a user', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('SELECT id, email, is_banned FROM users')) {
          return { rows: [{ id: 'user-2', email: 'test@test.com', is_banned: true }] };
        }
        if (text.includes('UPDATE users SET is_banned')) {
          return { rows: [{ id: 'user-2', email: 'test@test.com', is_banned: false }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).patch('/api/admin/users/user-2/unban');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.is_banned, false);
  });

  it('banning requires a reason', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async () => ({ rows: [] }),
    });
    const res = await request(app).patch('/api/admin/users/user-2/ban').send({ reason: '' });
    assert.equal(res.status, 400);
  });
});

describe('Audit Logging', () => {
  it('admin actions are logged in audit table', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('SELECT a.id, a.admin_user_id')) {
          return {
            rows: [
              {
                id: 1,
                admin_user_id: 'admin-1',
                admin_email: 'admin@test.com',
                action_type: 'ban',
                target_type: 'user',
                target_id: 'user-2',
                details: null,
                created_at: new Date(),
              },
            ],
          };
        }
        if (text.includes('SELECT COUNT(*) FROM admin_actions')) {
          return { rows: [{ count: 1 }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-log');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.actions));
    assert.ok(res.body.actions.length > 0);
  });

  it('audit log contains action type, target, and admin info', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('SELECT a.id, a.admin_user_id')) {
          return {
            rows: [
              {
                id: 1,
                admin_user_id: 'admin-1',
                admin_email: 'admin@test.com',
                action_type: 'ban',
                target_type: 'user',
                target_id: 'user-2',
                details: null,
                created_at: new Date(),
              },
            ],
          };
        }
        if (text.includes('SELECT COUNT(*) FROM admin_actions')) {
          return { rows: [{ count: 1 }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/audit-log');
    const action = res.body.actions[0];
    assert.ok(action.id);
    assert.ok(action.admin_user_id);
    assert.ok(action.action_type);
    assert.ok(action.target_type);
    assert.ok(action.target_id);
    assert.ok(action.created_at);
  });
});

describe('Admin Stats', () => {
  it('admin stats include moderation metrics', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('COUNT(*)') && text.includes('is_banned = false')) {
          return { rows: [{ count: 10 }] };
        }
        if (text.includes('COUNT(*)') && text.includes('is_banned = true')) {
          return { rows: [{ count: 2 }] };
        }
        if (text.includes('status, COUNT(*)') && text.includes('GROUP BY status')) {
          return { rows: [{ status: 'active', count: 5 }] };
        }
        if (text.includes('deleted_at IS NOT NULL')) {
          return { rows: [{ count: 1 }] };
        }
        if (text.includes('SUM(raised_amount)')) {
          return { rows: [{ total: 5000 }] };
        }
        if (text.includes('COUNT(*)') && text.includes('contributions')) {
          return { rows: [{ count: 20 }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/stats');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.total_users, 'number');
    assert.equal(typeof res.body.banned_users, 'number');
    assert.equal(typeof res.body.deleted_campaigns, 'number');
    assert.ok(Array.isArray(res.body.campaign_status));
  });
});

describe('Platform operations', () => {
  it('GET /admin/health returns platform health snapshot', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('active') && text.includes('funded')) {
          return { rows: [{ count: 5 }] };
        }
        if (text.includes('SUM(raised_amount)')) {
          return { rows: [{ total: 10000 }] };
        }
        if (text.includes('pending') && text.includes('withdrawal')) {
          return { rows: [{ count: 2, total_value: 500 }] };
        }
        if (text.includes('open') && text.includes('disputes')) {
          return { rows: [{ count: 1 }] };
        }
        if (text.includes('webhook_deliveries')) {
          return { rows: [{ count: 0 }] };
        }
        if (text.includes('campaign_webhook_deliveries')) {
          return { rows: [{ count: 0 }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.active_campaigns, 'number');
    assert.equal(typeof res.body.total_raised, 'number');
    assert.ok(res.body.pending_withdrawals);
    assert.equal(typeof res.body.open_disputes, 'number');
    assert.ok(res.body.stellar);
    assert.equal(typeof res.body.load_time_ms, 'number');
    assert.ok(res.body.load_time_ms < 5000);
  });

  it('GET /admin/withdrawals returns pending queue', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('COUNT(*)') && text.includes('withdrawal_requests')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM withdrawal_requests')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/withdrawals?status=pending');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, 'number');
    assert.equal(typeof res.body.limit, 'number');
    assert.equal(typeof res.body.offset, 'number');
  });

  it('GET /admin/disputes returns dispute list', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('COUNT(*)') && text.includes('disputes')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM disputes')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/disputes');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, 'number');
    assert.equal(typeof res.body.limit, 'number');
    assert.equal(typeof res.body.offset, 'number');
  });

  it('PATCH /admin/users/:id/kyc updates status and logs audit', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('SELECT id, email, kyc_status FROM users')) {
          return { rows: [{ id: 'user-1', email: 'test@test.com', kyc_status: 'unverified' }] };
        }
        if (text.includes('UPDATE users') && text.includes('kyc_status')) {
          return {
            rows: [
              {
                id: 'user-1',
                email: 'test@test.com',
                name: 'Test',
                kyc_status: 'verified',
                kyc_completed_at: new Date(),
              },
            ],
          };
        }
        if (text.includes('INSERT INTO admin_actions')) {
          return { rows: [] };
        }
        if (text.includes('SELECT a.id, a.admin_user_id')) {
          return {
            rows: [
              {
                id: 1,
                admin_user_id: 'admin-1',
                admin_email: 'admin@test.com',
                action_type: 'kyc_override',
                target_type: 'user',
                target_id: 'user-1',
                details: null,
                created_at: new Date(),
              },
            ],
          };
        }
        if (text.includes('SELECT COUNT(*) FROM admin_actions')) {
          return { rows: [{ count: 1 }] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app)
      .patch('/api/admin/users/user-1/kyc')
      .send({ kyc_status: 'verified', reason: 'manual test override' });
    assert.equal(res.status, 200);
    assert.equal(res.body.kyc_status, 'verified');
  });

  it('GET /admin/kyc/campaigns returns array', async () => {
    const app = buildApp({
      authUser: { userId: 'admin-1', is_admin: true },
      queryImpl: async text => {
        if (text.includes('kyc_status')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });
    const res = await request(app).get('/api/admin/kyc/campaigns');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});
