const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const proxyquire = require('proxyquire').noCallThru();

const mockQuery = async (text) => {
  if (text.includes('FROM campaigns WHERE status IN')) {
    return { rows: [{ count: 3 }] };
  }
  if (text.includes('SUM(raised_amount)')) {
    return { rows: [{ total: '1500' }] };
  }
  if (text.includes('FROM withdrawal_requests WHERE status')) {
    return { rows: [{ count: 2, total_value: '400' }] };
  }
  if (text.includes('FROM disputes WHERE status IN')) {
    return { rows: [{ count: 1 }] };
  }
  if (text.includes('FROM webhook_deliveries WHERE status')) {
    return { rows: [{ count: 2 }] };
  }
  if (text.includes('FROM campaign_webhook_deliveries WHERE status')) {
    return { rows: [{ count: 1 }] };
  }
  if (text.includes('FROM withdrawal_requests wr')) {
    return {
      rows: [{
        id: 'w-1',
        campaign_title: 'Test',
        creator_name: 'Alice',
        amount: '100',
        asset_type: 'XLM',
        status: 'pending',
        creator_signed: true,
        platform_signed: false,
        created_at: new Date().toISOString(),
      }],
    };
  }
  if (text.includes('FROM disputes d')) {
    return { rows: [] };
  }
  if (text.includes('INSERT INTO admin_actions')) {
    return { rows: [] };
  }
  if (text.includes('UPDATE users') && text.includes('kyc_status')) {
    return { rows: [{ id: 'u-1', email: 'a@test.com', name: 'A', kyc_status: 'verified', kyc_completed_at: new Date().toISOString() }] };
  }
  if (text.includes('SELECT id, email, kyc_status FROM users WHERE id')) {
    return { rows: [{ id: 'u-1', email: 'a@test.com', kyc_status: 'pending' }] };
  }
  return { rows: [] };
};

function buildApp() {
  const adminRouter = proxyquire('./admin', {
    '../config/database': { query: mockQuery },
    '../config/stellar': {
      server: {
        ledgers: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({ records: [{ sequence: 12345 }] }),
            }),
          }),
        }),
        feeStats: async () => ({ last_ledger_base_fee: 100 }),
      },
    },
    '../services/reconciliation': {
      reconcileSingleCampaign: async () => ({ updated: false }),
      getRecentReconciliationRuns: () => [{ started_at: new Date().toISOString(), campaigns_checked: 1, updated: 0, skipped: 0, errors: 0 }],
    },
    '../services/webhookDispatcher': {
      processDelivery: async () => {},
      processCampaignWebhookDelivery: async () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'admin-1', is_admin: true, role: 'admin' };
        next();
      },
      requireAdmin: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

test('GET /api/admin/health returns aggregated platform health', async () => {
  const app = buildApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.active_campaigns, 3);
    assert.strictEqual(body.open_disputes, 1);
    assert.ok(body.stellar.current_ledger);
    assert.ok(body.load_time_ms >= 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/admin/withdrawals returns pending queue', async () => {
  const app = buildApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/withdrawals`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].id, 'w-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('PATCH /api/admin/users/:id/kyc updates user status', async () => {
  const app = buildApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/u-1/kyc`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kyc_status: 'verified', reason: 'manual' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.kyc_status, 'verified');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
