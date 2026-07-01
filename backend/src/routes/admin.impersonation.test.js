const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const proxyquire = require('proxyquire').noCallThru();

process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';

let queryCalls;

const targetUser = {
  id: 'user-2',
  email: 'user@example.com',
  name: 'Debug User',
  role: 'creator',
  is_admin: false,
  is_banned: false,
};

beforeEach(() => {
  queryCalls = [];
});

const mockQuery = async (text, params = []) => {
  queryCalls.push({ text, params });

  if (text.includes('SELECT id, email, name, role, is_admin, is_banned')) {
    return { rows: [targetUser] };
  }

  if (text.includes('INSERT INTO admin_actions')) {
    return { rows: [] };
  }

  return { rows: [] };
};

function buildApp({
  user = { userId: 'admin-1', is_admin: true, role: 'admin' },
  impersonation = null,
} = {}) {
  const adminRouter = proxyquire('./admin', {
    '../config/database': { query: mockQuery },
    '../config/logger': { error: () => {}, info: () => {} },
    '../config/stellar': {
      server: {
        ledgers: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({ records: [] }),
            }),
          }),
        }),
        feeStats: async () => ({}),
      },
    },
    '../services/reconciliation': {
      reconcileSingleCampaign: async () => ({}),
      getRecentReconciliationRuns: () => [],
    },
    '../services/webhookDispatcher': {
      processDelivery: async () => {},
      processCampaignWebhookDelivery: async () => {},
    },
    '../utils/cache': {
      invalidate: () => {},
      invalidatePrefix: () => {},
    },
    '../middleware/auth': {
      IMPERSONATION_TOKEN_COOKIE_NAME: 'cp_impersonation_token',
      requireAuth: (req, _res, next) => {
        req.user = user;
        if (impersonation) {
          req.impersonation = impersonation;
          req.auth = { kind: 'jwt', impersonated: true };
        }
        next();
      },
      requireAdmin: (req, res, next) => {
        if (!req.user?.is_admin) {
          return res.status(403).json({ error: 'Requires admin privileges' });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/admin/impersonate/:userId returns a 15-minute impersonation token', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/impersonate/${targetUser.id}`, {
      method: 'POST',
    });

    assert.equal(res.status, 201);

    const body = await res.json();
    const decoded = jwt.verify(body.token, process.env.JWT_SECRET);
    assert.equal(decoded.userId, targetUser.id);
    assert.equal(decoded.impersonated_by, 'admin-1');
    assert.equal(decoded.impersonation, true);
    assert.ok(decoded.exp - decoded.iat <= 900);

    assert.equal(body.expires_in, 900);
    assert.equal(body.user.id, targetUser.id);
    assert.match(res.headers.get('set-cookie'), /cp_impersonation_token=/);

    const auditCall = queryCalls.find((call) => call.params[1] === 'impersonate_start');
    assert.ok(auditCall);
    assert.equal(auditCall.params[0], 'admin-1');
    assert.equal(auditCall.params[3], targetUser.id);
  });
});

test('POST /api/admin/impersonate/exit clears cookie and logs the end event', async () => {
  const impersonation = { adminUserId: 'admin-1', targetUserId: targetUser.id };
  const user = {
    userId: targetUser.id,
    role: 'creator',
    impersonated_by: 'admin-1',
  };

  await withServer(buildApp({ user, impersonation }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/impersonate/exit`, {
      method: 'POST',
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /cp_impersonation_token=/);

    const auditCall = queryCalls.find((call) => call.params[1] === 'impersonate_end');
    assert.ok(auditCall);
    assert.equal(auditCall.params[0], 'admin-1');
    assert.equal(auditCall.params[3], targetUser.id);
  });
});
