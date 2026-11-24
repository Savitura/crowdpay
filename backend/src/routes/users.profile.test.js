const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({
  query = async () => ({ rows: [] }),
  kycRequired = false,
  user = { userId: 'user-1', role: 'contributor' },
  impersonation = null,
  authenticated = true,
} = {}) {
  const router = proxyquire('./users', {
    '../config/database': { query },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!authenticated) return res.status(401).json({ error: 'Unauthorized' });
        req.user = user;
        if (impersonation) req.impersonation = impersonation;
        next();
      },
    },
    '../services/kycProvider': { isKycRequiredForCampaigns: () => kycRequired },
    '../services/kycService': { startKycForUser: async () => ({ status: 'verified' }) },
    '../services/userDashboardService': {
      listCreatorCampaigns: async () => [],
      listUserContributions: async () => [],
    },
    '../services/campaignFollowService': { listFollowedCampaigns: async () => [] },
    '../services/communicationPreferenceService': {
      listForUser: async () => [],
      resetAllForUser: async () => 0,
    },
    '../services/badgeService': {
      evaluateBadges: async () => [],
      getLeaderboard: async () => [],
    },
    '../services/stellarService': {
      getCampaignBalance: async () => '0',
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_secret, _context, fn) => fn('decrypted-secret'),
    },
    '../services/emailService': { sendWalletFundingFailedEmail: async () => {} },
    '../services/analyticsService': { getUserDashboardAnalytics: async () => ({}) },
    '../services/auditService': {
      getCredentialActivity: async () => [],
      logAuditEvent: async () => {},
    },
    '../services/exportService': {
      EXPORT_SCOPES: {},
      generateUserExport: async () => ({}),
      getExportDownloadUrl: async () => '',
    },
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './apiKeys': express.Router(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/users', router);
  return app;
}

test('GET /api/users/me exposes KYC and impersonation metadata without selecting secrets', async () => {
  let profileQuery = '';
  const app = buildApp({
    kycRequired: true,
    impersonation: { adminUserId: 'admin-9' },
    query: async (text, params) => {
      profileQuery = text;
      assert.deepEqual(params, ['user-1']);
      return {
        rows: [
          {
            id: 'user-1',
            email: 'ada@example.test',
            name: 'Ada',
            wallet_public_key: 'GABC',
          },
        ],
      };
    },
  });

  const res = await request(app).get('/api/users/me');

  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'user-1');
  assert.equal(res.body.name, 'Ada');
  assert.equal(res.body.kyc_required_for_campaigns, true);
  assert.deepEqual(res.body.impersonation, { active: true, admin_user_id: 'admin-9' });
  assert.equal(res.body.impersonated_by, 'admin-9');
  assert.equal(profileQuery.includes('wallet_secret_encrypted'), false);
});

test('GET /api/users/me returns 404 for a missing user', async () => {
  const res = await request(buildApp()).get('/api/users/me');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'User not found' });
});

test('PATCH /api/users/me trims the display name and rejects blank names', async () => {
  const calls = [];
  const app = buildApp({
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ id: 'user-1', email: 'ada@example.test', name: params[0] }] };
    },
  });

  const blank = await request(app).patch('/api/users/me').send({ name: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(calls.length, 0);

  const res = await request(app).patch('/api/users/me').send({ name: '  Ada Lovelace  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Ada Lovelace');
  assert.deepEqual(calls[0].params, ['Ada Lovelace', 'user-1']);
});

test('notification preference reads fall back to the legacy column set', async () => {
  const attempts = [];
  const app = buildApp({
    query: async text => {
      attempts.push(text);
      if (text.includes('category_digest FROM notification_preferences')) {
        const err = new Error('column category_digest does not exist');
        err.code = '42703';
        throw err;
      }
      return {
        rows: [
          {
            campaign_updates: false,
            refunds: true,
            disputes: true,
            milestones: true,
            marketing: true,
          },
        ],
      };
    },
  });

  const res = await request(app).get('/api/users/me/notification-preferences');

  assert.equal(res.status, 200);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].includes('category_digest'), false);
  assert.equal(res.body.category_digest, true);
  assert.equal(res.body.campaign_updates, false);
  assert.equal(res.body.marketing, true);
});

test('notification preference writes fall back to the legacy INSERT shape', async () => {
  const inserts = [];
  const app = buildApp({
    query: async (text, params) => {
      if (!text.includes('INSERT INTO notification_preferences')) return { rows: [] };
      inserts.push({ text, params });
      if (text.includes('category_digest')) {
        const err = new Error('column category_digest does not exist');
        err.code = '42703';
        throw err;
      }
      return {
        rows: [
          {
            campaign_updates: true,
            refunds: true,
            disputes: true,
            milestones: true,
            marketing: false,
          },
        ],
      };
    },
  });

  const res = await request(app)
    .patch('/api/users/me/notification-preferences')
    .send({ category_digest: false });

  assert.equal(res.status, 200);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[1].text.includes('category_digest'), false);
  assert.equal(inserts[1].params.length, 6);
  assert.equal(res.body.category_digest, true);
});

test('PATCH /api/users/me/contributor-privacy validates and persists privacy choices', async () => {
  const calls = [];
  const app = buildApp({
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ contributor_privacy: params[0] }] };
    },
  });

  const invalid = await request(app)
    .patch('/api/users/me/contributor-privacy')
    .send({ contributor_privacy: 'everyone' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /full, amount_only, anonymous/);
  assert.equal(calls.length, 0);

  const valid = await request(app)
    .patch('/api/users/me/contributor-privacy')
    .send({ contributor_privacy: 'amount_only' });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body, { contributor_privacy: 'amount_only' });
  assert.deepEqual(calls[0].params, ['amount_only', 'user-1']);
});

test('profile routes reject unauthenticated requests', async () => {
  const app = buildApp({ authenticated: false });

  assert.equal((await request(app).get('/api/users/me')).status, 401);
  assert.equal((await request(app).patch('/api/users/me').send({ name: 'Ada' })).status, 401);
  assert.equal(
    (await request(app).patch('/api/users/me/notification-preferences').send({ marketing: true }))
      .status,
    401
  );
  assert.equal(
    (
      await request(app)
        .patch('/api/users/me/contributor-privacy')
        .send({ contributor_privacy: 'anonymous' })
    ).status,
    401
  );
});
