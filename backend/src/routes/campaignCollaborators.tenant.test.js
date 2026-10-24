const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

if (!process.env.PLATFORM_SECRET_KEY) {
  process.env.PLATFORM_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.USDC_ISSUER) {
  process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/crowdpay_test';
}

const TENANT_ALPHA = '11111111-1111-1111-1111-111111111111';
const TENANT_BETA = '22222222-2222-2222-2222-222222222222';
const NON_EXISTENT_TENANT = '99999999-9999-9999-9999-999999999999';

const USER_ALPHA_CREATOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ALPHA_OWNER = 'a1111111-1111-1111-1111-111111111111';
const USER_ALPHA_EDITOR = 'a3333333-3333-3333-3333-333333333333';
const USER_ALPHA_VIEWER = 'a4444444-4444-4444-4444-444444444444';

const USER_BETA_CREATOR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_BETA_OWNER = 'b1111111-1111-1111-1111-111111111111';

// Dual-membership user: manager on Tenant Alpha, but viewer on Tenant Beta
const USER_DUAL = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// Stranger user: not a collaborator on any campaign
const USER_STRANGER = '88888888-8888-8888-8888-888888888888';

// Platform administrator
const USER_ADMIN = '00000000-0000-0000-0000-000000000000';

const INVITE_ALPHA_ID = 'e1111111-1111-1111-1111-111111111111';
const INVITE_BETA_ID = 'e2222222-2222-2222-2222-222222222222';

function createInitialState() {
  return {
    campaigns: [
      {
        id: TENANT_ALPHA,
        creator_id: USER_ALPHA_CREATOR,
        title: 'Campaign Alpha (Tenant A)',
        status: 'draft',
        is_hidden: false,
      },
      {
        id: TENANT_BETA,
        creator_id: USER_BETA_CREATOR,
        title: 'Campaign Beta (Tenant B)',
        status: 'draft',
        is_hidden: false,
      },
    ],
    campaign_members: [
      {
        id: 'mem-a-1',
        campaign_id: TENANT_ALPHA,
        user_id: USER_ALPHA_OWNER,
        email: 'alpha-owner@example.com',
        role: 'owner',
        accepted_at: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
        invite_token: null,
        invite_expires_at: null,
      },
      {
        id: 'mem-a-2',
        campaign_id: TENANT_ALPHA,
        user_id: USER_DUAL,
        email: 'dual-user@example.com',
        role: 'manager',
        accepted_at: '2026-01-02T00:00:00.000Z',
        created_at: '2026-01-02T00:00:00.000Z',
        invite_token: null,
        invite_expires_at: null,
      },
      {
        id: 'mem-a-3',
        campaign_id: TENANT_ALPHA,
        user_id: USER_ALPHA_EDITOR,
        email: 'alpha-editor@example.com',
        role: 'editor',
        accepted_at: '2026-01-03T00:00:00.000Z',
        created_at: '2026-01-03T00:00:00.000Z',
        invite_token: null,
        invite_expires_at: null,
      },
      {
        id: 'mem-a-4',
        campaign_id: TENANT_ALPHA,
        user_id: USER_ALPHA_VIEWER,
        email: 'alpha-viewer@example.com',
        role: 'viewer',
        accepted_at: '2026-01-04T00:00:00.000Z',
        created_at: '2026-01-04T00:00:00.000Z',
        invite_token: null,
        invite_expires_at: null,
      },
      {
        id: INVITE_ALPHA_ID,
        campaign_id: TENANT_ALPHA,
        user_id: null,
        email: 'pending-alpha@example.com',
        role: 'editor',
        accepted_at: null,
        created_at: '2026-01-05T00:00:00.000Z',
        invite_token: 'alpha-invite-token-1234567890abcdef1234567890abcdef',
        invite_expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      },
      {
        id: 'mem-b-1',
        campaign_id: TENANT_BETA,
        user_id: USER_BETA_OWNER,
        email: 'beta-owner@example.com',
        role: 'owner',
        accepted_at: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
        invite_token: null,
        invite_expires_at: null,
      },
      {
        id: 'mem-b-2',
        campaign_id: TENANT_BETA,
        user_id: USER_DUAL,
        email: 'dual-user@example.com',
        role: 'viewer',
        accepted_at: '2026-01-02T00:00:00.000Z',
        created_at: '2026-01-02T00:00:00.000Z',
        invite_token: null,
        invite_expires_at: null,
      },
      {
        id: INVITE_BETA_ID,
        campaign_id: TENANT_BETA,
        user_id: null,
        email: 'pending-beta@example.com',
        role: 'editor',
        accepted_at: null,
        created_at: '2026-01-05T00:00:00.000Z',
        invite_token: 'beta-invite-token-1234567890abcdef1234567890abcdef',
        invite_expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      },
    ],
    users: [
      { id: USER_ALPHA_CREATOR, email: 'alpha-creator@example.com', name: 'Alpha Creator' },
      { id: USER_ALPHA_OWNER, email: 'alpha-owner@example.com', name: 'Alpha Owner' },
      { id: USER_ALPHA_EDITOR, email: 'alpha-editor@example.com', name: 'Alpha Editor' },
      { id: USER_ALPHA_VIEWER, email: 'alpha-viewer@example.com', name: 'Alpha Viewer' },
      { id: USER_BETA_CREATOR, email: 'beta-creator@example.com', name: 'Beta Creator' },
      { id: USER_BETA_OWNER, email: 'beta-owner@example.com', name: 'Beta Owner' },
      { id: USER_DUAL, email: 'dual-user@example.com', name: 'Dual User' },
      { id: USER_STRANGER, email: 'stranger@example.com', name: 'Stranger User' },
      { id: USER_ADMIN, email: 'admin@example.com', name: 'Platform Admin' },
    ],
    campaign_updates: [],
  };
}

function buildTestEnvironment() {
  const state = createInitialState();

  const mockDbQuery = async (text, params = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();

    // 1. SELECT creator_id FROM campaigns WHERE id = $1
    // or SELECT id, creator_id, title FROM campaigns WHERE id = $1
    // or SELECT title FROM campaigns WHERE id = $1
    if (sql.includes('FROM campaigns WHERE id = $1')) {
      const camp = state.campaigns.find(c => c.id === params[0]);
      return { rows: camp ? [camp] : [] };
    }

    // 2. SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2
    if (sql.includes('FROM campaign_members WHERE campaign_id = $1 AND user_id = $2')) {
      const [campaignId, userId] = params;
      const mem = state.campaign_members.find(
        m => m.campaign_id === campaignId && m.user_id === userId
      );
      return { rows: mem ? [{ role: mem.role, accepted_at: mem.accepted_at }] : [] };
    }

    // 3. SELECT COUNT(*)::int AS total FROM campaign_members WHERE campaign_id = $1
    if (
      sql.includes('SELECT COUNT(*)::int AS total FROM campaign_members WHERE campaign_id = $1')
    ) {
      const count = state.campaign_members.filter(m => m.campaign_id === params[0]).length;
      return { rows: [{ total: count }] };
    }

    // 4. Listing members query
    if (sql.includes('FROM campaign_members cm') && sql.includes('WHERE cm.campaign_id = $1')) {
      const members = state.campaign_members
        .filter(m => m.campaign_id === params[0])
        .map(m => {
          const user = state.users.find(u => u.id === m.user_id);
          return {
            id: m.id,
            user_id: m.user_id,
            email: m.email,
            role: m.role,
            accepted_at: m.accepted_at,
            created_at: m.created_at,
            invite_expires_at: m.invite_expires_at,
            user_name: user?.name || null,
          };
        });
      return { rows: members };
    }

    // 5. Existing invite lookup by email
    if (sql.includes('FROM campaign_members WHERE campaign_id = $1 AND LOWER(email) = $2')) {
      const [campaignId, email] = params;
      const mem = state.campaign_members.find(
        m => m.campaign_id === campaignId && m.email.toLowerCase() === email.toLowerCase()
      );
      return { rows: mem ? [{ id: mem.id, accepted_at: mem.accepted_at }] : [] };
    }

    // 6. User lookup by email
    if (sql.includes('SELECT id FROM users WHERE LOWER(email) = $1')) {
      const user = state.users.find(u => u.email.toLowerCase() === params[0].toLowerCase());
      return { rows: user ? [{ id: user.id }] : [] };
    }

    // 7. Insert campaign member (invite creation)
    if (sql.includes('INSERT INTO campaign_members')) {
      const [campaignId, userId, email, role, invitedBy, inviteToken, expiresAt] = params;
      const newMember = {
        id: `mem-new-${Date.now()}-${Math.random()}`,
        campaign_id: campaignId,
        user_id: userId,
        email,
        role,
        invited_by: invitedBy,
        invite_token: inviteToken,
        invite_expires_at: expiresAt,
        accepted_at: null,
        created_at: new Date().toISOString(),
      };
      state.campaign_members.push(newMember);
      return { rows: [newMember] };
    }

    // 8. Update member role (owner modifying member)
    if (
      sql.includes('UPDATE campaign_members SET role = $1') &&
      sql.includes('WHERE campaign_id = $2 AND user_id = $3')
    ) {
      const [newRole, campaignId, userId] = params;
      const mem = state.campaign_members.find(
        m => m.campaign_id === campaignId && m.user_id === userId && m.accepted_at !== null
      );
      if (mem) {
        mem.role = newRole;
        return {
          rows: [
            {
              id: mem.id,
              campaign_id: mem.campaign_id,
              user_id: mem.user_id,
              role: mem.role,
              accepted_at: mem.accepted_at,
            },
          ],
        };
      }
      return { rows: [] };
    }

    // 9. Resend invite
    if (
      sql.includes('UPDATE campaign_members SET invite_token = $1') &&
      sql.includes('WHERE id = $3 AND campaign_id = $4')
    ) {
      const [token, expiresAt, memberId, campaignId] = params;
      const mem = state.campaign_members.find(
        m => m.id === memberId && m.campaign_id === campaignId && m.accepted_at === null
      );
      if (mem) {
        mem.invite_token = token;
        mem.invite_expires_at = expiresAt;
        return {
          rows: [
            {
              id: mem.id,
              campaign_id: mem.campaign_id,
              email: mem.email,
              role: mem.role,
              accepted_at: mem.accepted_at,
              invite_expires_at: mem.invite_expires_at,
              created_at: mem.created_at,
            },
          ],
        };
      }
      return { rows: [] };
    }

    // 10. Cancel invite
    if (
      sql.includes(
        'DELETE FROM campaign_members WHERE id = $1 AND campaign_id = $2 AND accepted_at IS NULL'
      )
    ) {
      const [memberId, campaignId] = params;
      const idx = state.campaign_members.findIndex(
        m => m.id === memberId && m.campaign_id === campaignId && m.accepted_at === null
      );
      if (idx !== -1) {
        const [removed] = state.campaign_members.splice(idx, 1);
        return { rows: [{ id: removed.id }] };
      }
      return { rows: [] };
    }

    // 11. Delete member
    if (sql.includes('DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2')) {
      const [campaignId, userId] = params;
      const idx = state.campaign_members.findIndex(
        m => m.campaign_id === campaignId && m.user_id === userId
      );
      if (idx !== -1) {
        const [removed] = state.campaign_members.splice(idx, 1);
        return { rows: [{ id: removed.id }] };
      }
      return { rows: [] };
    }

    // 12. Count accepted owners
    if (
      sql.includes(
        "SELECT COUNT(*)::int AS count FROM campaign_members WHERE campaign_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL"
      )
    ) {
      const count = state.campaign_members.filter(
        m => m.campaign_id === params[0] && m.role === 'owner' && m.accepted_at !== null
      ).length;
      return { rows: [{ count }] };
    }

    // 13. Campaign updates insertion
    if (sql.includes('INSERT INTO campaign_updates')) {
      const [campaignId, authorId, title, body] = params;
      const update = {
        id: `update-${Date.now()}`,
        campaign_id: campaignId,
        author_id: authorId,
        title,
        body,
        created_at: new Date().toISOString(),
      };
      state.campaign_updates.push(update);
      return { rows: [update] };
    }

    // 14. Update campaign
    if (sql.includes('UPDATE campaigns SET') && sql.includes('WHERE id = $')) {
      const camp = state.campaigns.find(c => c.id === params[params.length - 1]);
      if (camp) {
        return { rows: [camp] };
      }
      return { rows: [] };
    }

    return { rows: [] };
  };

  const dbModule = {
    query: mockDbQuery,
    connect: async () => ({
      query: mockDbQuery,
      release: async () => {},
    }),
  };

  const inviteService = proxyquire('../services/campaignInviteService', {
    '../config/database': dbModule,
    '../config/logger': { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
    './emailService': { sendEmail: async () => {} },
  });

  const campaignsRouter = proxyquire('./campaigns', {
    '../config/database': dbModule,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../services/campaignInviteService': inviteService,
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        const userId = req.headers['x-test-user-id'];
        if (!userId) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const role = req.headers['x-test-user-role'] || 'user';
        req.user = { userId, role };
        next();
      },
      requireRole:
        (...roles) =>
        (req, res, next) => {
          if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient role' });
          }
          next();
        },
      optionalAuth: (req, _res, next) => {
        const userId = req.headers['x-test-user-id'];
        if (userId) {
          req.user = { userId, role: req.headers['x-test-user-role'] || 'user' };
        }
        next();
      },
    },
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds: async () => ({ refundsCreated: 0, refunds: [] }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['USDC', 'XLM'],
      buildWithdrawalTransaction: async () => '',
    },
    '../services/ledgerMonitor': {
      watchCampaignWallet: async () => {},
      addSSEClient: () => {},
      removeSSEClient: () => {},
      cleanupStreamForWallet: () => {},
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => 'tx-row',
    },
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
      getContractStatus: async () => ({}),
    },
    '../services/emailService': {
      sendEmail: async () => {},
      sendTeamMemberInvitedEmail: async () => {},
    },
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
    '../services/storage': {
      uploadCampaignCoverImage: async () => '/images/cover.jpg',
    },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
      getTierLimit: () => 50000,
      VERIFICATION_TIER_LIMITS: { none: 0, basic: 5000, standard: 50000, enhanced: Infinity },
    },
    '../services/userDashboardService': { listCreatorCampaigns: async () => [] },
    '../services/trendingService': { getTrendingCampaigns: async () => [] },
    '../services/campaignRecommendationService': { getRecommendedCampaigns: async () => [] },
    '../middleware/validation': {
      createCampaignValidation: [],
      createCampaignUpdateValidation: [],
      updateCampaignValidation: [],
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
      createValidateRequest: () => (_req, _res, next) => next(),
    },
    '../services/analyticsService': {
      getCampaignAnalytics: async id => ({
        overview: { campaign_id: id, total_raised: 1000 },
        chart: [],
      }),
      getCampaignContributors: async id => [{ campaign_id: id, country: 'US', count: 10 }],
      getCampaignBackers: async id => [{ campaign_id: id, backer_name: 'Supporter' }],
    },
    '../services/campaignReportService': {
      assembleReport: async () => ({}),
      generateSignedUrl: () => 'https://crowdpay.io/report',
      verifySignedToken: () => true,
    },
    '../services/campaignReportPdf': {
      streamCampaignReportPdf: (_r, res) => res.end(),
      reportFilename: () => 'report.pdf',
    },
    '../services/rewardTierService': {
      getFulfillmentsByCampaign: async id => [{ id: 'f-1', campaign_id: id, status: 'pending' }],
      getCampaignFulfillmentSummary: async () => ({ pending: 1 }),
      updateFulfillmentStatus: async () => ({ status: 'shipped' }),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', campaignsRouter);
  app.use((err, _req, res, _next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message || 'Error' });
  });

  return { app, state, inviteService };
}

test.describe('Tenant-Aware Authorization for Campaign Collaborators', () => {
  // ── 1. PRIMARY PATH: Authorized Collaborator within Own Tenant ────────────────

  test.describe('Primary Path: Intended intra-tenant collaborator operations', () => {
    test('campaign owner on Tenant Alpha can list team members of Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_ALPHA}/members`)
        .set('x-test-user-id', USER_ALPHA_OWNER);

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.some(m => m.email === 'alpha-owner@example.com'));
      assert.ok(res.body.data.every(m => !m.campaign_id || m.campaign_id === TENANT_ALPHA));
    });

    test('campaign manager on Tenant Alpha can list team members of Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_ALPHA}/members`)
        .set('x-test-user-id', USER_DUAL); // manager on Alpha

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.equal(res.body.total, 5); // 4 accepted + 1 pending in Alpha
    });

    test('campaign manager on Tenant Alpha can invite a collaborator to Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/members/invite`)
        .set('x-test-user-id', USER_DUAL)
        .send({ email: 'new-collaborator@example.com', role: 'editor' });

      assert.equal(res.status, 201);
      assert.equal(res.body.campaign_id, TENANT_ALPHA);
      assert.equal(res.body.email, 'new-collaborator@example.com');
      assert.equal(res.body.role, 'editor');
    });

    test('campaign owner on Tenant Alpha can update collaborator role within Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .patch(`/api/campaigns/${TENANT_ALPHA}/members/${USER_ALPHA_EDITOR}`)
        .set('x-test-user-id', USER_ALPHA_OWNER)
        .send({ role: 'manager' });

      assert.equal(res.status, 200);
      assert.equal(res.body.user_id, USER_ALPHA_EDITOR);
      assert.equal(res.body.role, 'manager');
      assert.equal(res.body.campaign_id, TENANT_ALPHA);
    });

    test('campaign manager on Tenant Alpha can resend a pending invite for Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/members/${INVITE_ALPHA_ID}/resend`)
        .set('x-test-user-id', USER_DUAL);

      assert.equal(res.status, 200);
      assert.equal(res.body.id, INVITE_ALPHA_ID);
      assert.equal(res.body.campaign_id, TENANT_ALPHA);
    });

    test('campaign manager on Tenant Alpha can cancel a pending invite for Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .delete(`/api/campaigns/${TENANT_ALPHA}/members/invites/${INVITE_ALPHA_ID}`)
        .set('x-test-user-id', USER_DUAL);

      assert.equal(res.status, 200);
      assert.equal(res.body.cancelled, true);
    });

    test('campaign manager on Tenant Alpha can publish an update to Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/updates`)
        .set('x-test-user-id', USER_DUAL)
        .send({ title: 'Milestone 1 reached', body: 'Great progress in Tenant Alpha!' });

      assert.equal(res.status, 201);
      assert.equal(res.body.campaign_id, TENANT_ALPHA);
      assert.equal(res.body.title, 'Milestone 1 reached');
    });

    test('campaign viewer on Tenant Alpha can view Tenant Alpha analytics', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_ALPHA}/analytics`)
        .set('x-test-user-id', USER_ALPHA_VIEWER);

      assert.equal(res.status, 200);
      assert.equal(res.body.overview.campaign_id, TENANT_ALPHA);
    });

    test('collaborator on Tenant Alpha can self-leave Tenant Alpha', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .delete(`/api/campaigns/${TENANT_ALPHA}/members/${USER_ALPHA_EDITOR}`)
        .set('x-test-user-id', USER_ALPHA_EDITOR);

      assert.equal(res.status, 200);
      assert.match(res.body.message, /removed successfully/i);
    });
  });

  // ── 2. CROSS-TENANT ACCESS DENIAL (Security Boundary Enforcement) ──────────────

  test.describe('Cross-Tenant Denial: Collaborator privileges do not extend across tenants', () => {
    test('collaborator on Tenant Alpha (owner) is forbidden from listing members of Tenant Beta', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_BETA}/members`)
        .set('x-test-user-id', USER_ALPHA_OWNER);

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('collaborator on Tenant Alpha (owner) is forbidden from inviting members to Tenant Beta', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_BETA}/members/invite`)
        .set('x-test-user-id', USER_ALPHA_OWNER)
        .send({ email: 'infiltrator@example.com', role: 'editor' });

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('collaborator on Tenant Alpha (owner) is forbidden from altering collaborator roles on Tenant Beta', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .patch(`/api/campaigns/${TENANT_BETA}/members/${USER_BETA_OWNER}`)
        .set('x-test-user-id', USER_ALPHA_OWNER)
        .send({ role: 'viewer' });

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('collaborator on Tenant Alpha (owner) is forbidden from removing members on Tenant Beta', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .delete(`/api/campaigns/${TENANT_BETA}/members/${USER_BETA_OWNER}`)
        .set('x-test-user-id', USER_ALPHA_OWNER);

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('collaborator on Tenant Alpha (manager) is forbidden from posting updates to Tenant Beta', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_BETA}/updates`)
        .set('x-test-user-id', USER_ALPHA_OWNER)
        .send({ title: 'Rogue Update', body: 'Cross-tenant breach attempt' });

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('collaborator on Tenant Alpha (editor) is forbidden from editing Tenant Beta content', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .patch(`/api/campaigns/${TENANT_BETA}`)
        .set('x-test-user-id', USER_ALPHA_EDITOR)
        .send({ title: 'Hacked Title' });

      assert.equal(res.status, 403);
      assert.match(res.body.error, /permission/i);
    });

    test('collaborator on Tenant Alpha (viewer) is forbidden from viewing Tenant Beta analytics', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_BETA}/analytics`)
        .set('x-test-user-id', USER_ALPHA_VIEWER);

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('collaborator on Tenant Alpha is forbidden from accessing Tenant Beta fulfillments', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_BETA}/fulfillments`)
        .set('x-test-user-id', USER_ALPHA_OWNER);

      assert.equal(res.status, 403);
      assert.match(res.body.error, /insufficient permissions/i);
    });

    test('stranger without any campaign membership is rejected with 403 across all campaigns', async () => {
      const { app } = buildTestEnvironment();

      const resAlpha = await request(app)
        .get(`/api/campaigns/${TENANT_ALPHA}/members`)
        .set('x-test-user-id', USER_STRANGER);
      assert.equal(resAlpha.status, 403);

      const resBeta = await request(app)
        .get(`/api/campaigns/${TENANT_BETA}/members`)
        .set('x-test-user-id', USER_STRANGER);
      assert.equal(resBeta.status, 403);
    });

    test('collaborator request against nonexistent campaign tenant returns 404', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${NON_EXISTENT_TENANT}/members`)
        .set('x-test-user-id', USER_ALPHA_OWNER);

      assert.equal(res.status, 404);
      assert.match(res.body.error, /campaign not found/i);
    });
  });

  // ── 3. CROSS-TENANT PARAMETER TAMPERING / IDOR PREVENTION ─────────────────────

  test.describe('Cross-Tenant IDOR: Preventing sub-resource tampering across tenants', () => {
    test('manager of Tenant Alpha cannot resend an invitation belonging to Tenant Beta by passing Alpha tenant path', async () => {
      const { app } = buildTestEnvironment();
      // Target Tenant Alpha endpoint (where caller is manager), but pass Tenant Beta invite ID
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/members/${INVITE_BETA_ID}/resend`)
        .set('x-test-user-id', USER_DUAL);

      // The invite is scoped by campaign_id in the query, so it must return 404
      assert.equal(res.status, 404);
      assert.match(res.body.error, /pending invitation not found/i);
    });

    test('manager of Tenant Alpha cannot cancel an invitation belonging to Tenant Beta by passing Alpha tenant path', async () => {
      const { app } = buildTestEnvironment();
      // Target Tenant Alpha endpoint, but pass Tenant Beta invite ID
      const res = await request(app)
        .delete(`/api/campaigns/${TENANT_ALPHA}/members/invites/${INVITE_BETA_ID}`)
        .set('x-test-user-id', USER_DUAL);

      assert.equal(res.status, 404);
      assert.match(res.body.error, /pending invitation not found/i);
    });

    test('owner of Tenant Alpha cannot alter role of a user belonging exclusively to Tenant Beta via Alpha tenant route', async () => {
      const { app } = buildTestEnvironment();
      // USER_BETA_OWNER is only in Beta, not Alpha. Call Alpha endpoint with Beta user
      const res = await request(app)
        .patch(`/api/campaigns/${TENANT_ALPHA}/members/${USER_BETA_OWNER}`)
        .set('x-test-user-id', USER_ALPHA_OWNER)
        .send({ role: 'viewer' });

      assert.equal(res.status, 404);
      assert.match(res.body.error, /member not found/i);
    });

    test('owner of Tenant Alpha cannot remove a user belonging exclusively to Tenant Beta via Alpha tenant route', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .delete(`/api/campaigns/${TENANT_ALPHA}/members/${USER_BETA_OWNER}`)
        .set('x-test-user-id', USER_ALPHA_OWNER);

      assert.equal(res.status, 404);
      assert.match(res.body.error, /member not found/i);
    });

    test('collaborator of Tenant Alpha cannot self-leave Tenant Beta where they have no membership', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .delete(`/api/campaigns/${TENANT_BETA}/members/${USER_ALPHA_EDITOR}`)
        .set('x-test-user-id', USER_ALPHA_EDITOR);

      // They are self-leaving, but since they don't belong to Tenant Beta, 404 is returned
      assert.equal(res.status, 404);
      assert.match(res.body.error, /member not found/i);
    });
  });

  // ── 4. MULTI-TENANT ROLE INDEPENDENCE (Dual-Membership Boundary) ─────────────

  test.describe('Multi-Tenant Dual-Role Independence: Privileges do not leak across tenants', () => {
    test('user who is manager on Tenant Alpha can invite members to Alpha, but forbidden on Tenant Beta where they are only viewer', async () => {
      const { app } = buildTestEnvironment();

      // 1. Inviting on Tenant Alpha (where user is manager) -> succeeds
      const resAlpha = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/members/invite`)
        .set('x-test-user-id', USER_DUAL)
        .send({ email: 'alpha-new@example.com', role: 'editor' });
      assert.equal(resAlpha.status, 201);

      // 2. Inviting on Tenant Beta (where user is viewer) -> rejected with 403
      const resBeta = await request(app)
        .post(`/api/campaigns/${TENANT_BETA}/members/invite`)
        .set('x-test-user-id', USER_DUAL)
        .send({ email: 'beta-new@example.com', role: 'editor' });
      assert.equal(resBeta.status, 403);
      assert.match(resBeta.body.error, /insufficient permissions/i);
    });

    test('user who is manager on Tenant Alpha can post updates on Alpha, but forbidden on Tenant Beta where they are only viewer', async () => {
      const { app } = buildTestEnvironment();

      // Alpha: post update allowed
      const resAlpha = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/updates`)
        .set('x-test-user-id', USER_DUAL)
        .send({ title: 'Alpha Update', body: 'Authorized manager update' });
      assert.equal(resAlpha.status, 201);

      // Beta: post update forbidden (viewers cannot post updates)
      const resBeta = await request(app)
        .post(`/api/campaigns/${TENANT_BETA}/updates`)
        .set('x-test-user-id', USER_DUAL)
        .send({ title: 'Beta Update', body: 'Unauthorized viewer update' });
      assert.equal(resBeta.status, 403);
      assert.match(resBeta.body.error, /insufficient permissions/i);
    });

    test('user who is viewer on Tenant Beta CAN view analytics on Beta as permitted by viewer role', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .get(`/api/campaigns/${TENANT_BETA}/analytics`)
        .set('x-test-user-id', USER_DUAL);

      assert.equal(res.status, 200);
      assert.equal(res.body.overview.campaign_id, TENANT_BETA);
    });

    test('manager cannot escalate privileges to assign owner role even in their authorized tenant', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_ALPHA}/members/invite`)
        .set('x-test-user-id', USER_DUAL) // manager on Alpha
        .send({ email: 'escalated@example.com', role: 'owner' });

      assert.equal(res.status, 403);
      assert.match(res.body.error, /only an owner can assign the owner role/i);
    });
  });

  // ── 5. PLATFORM ADMIN OVERRIDE ───────────────────────────────────────────────

  test.describe('Platform Admin: Platform administrators have cross-tenant management access', () => {
    test('platform admin can list members on any tenant without explicit campaign_members row', async () => {
      const { app } = buildTestEnvironment();

      const resAlpha = await request(app)
        .get(`/api/campaigns/${TENANT_ALPHA}/members`)
        .set('x-test-user-id', USER_ADMIN)
        .set('x-test-user-role', 'admin');
      assert.equal(resAlpha.status, 200);

      const resBeta = await request(app)
        .get(`/api/campaigns/${TENANT_BETA}/members`)
        .set('x-test-user-id', USER_ADMIN)
        .set('x-test-user-role', 'admin');
      assert.equal(resBeta.status, 200);
    });

    test('platform admin can invite collaborators on any tenant', async () => {
      const { app } = buildTestEnvironment();
      const res = await request(app)
        .post(`/api/campaigns/${TENANT_BETA}/members/invite`)
        .set('x-test-user-id', USER_ADMIN)
        .set('x-test-user-role', 'admin')
        .send({ email: 'admin-invite@example.com', role: 'owner' });

      assert.equal(res.status, 201);
      assert.equal(res.body.campaign_id, TENANT_BETA);
    });
  });

  // ── 6. SERVICE-LEVEL TENANT SCOPING (campaignInviteService & helpers) ─────────

  test.describe('Service-Level Tenant Isolation: campaignInviteService', () => {
    test('resolveUserCampaignRole scopes strictly to the requested campaign tenant', async () => {
      const { inviteService } = buildTestEnvironment();

      // USER_ALPHA_OWNER is owner on Alpha, but null on Beta
      assert.equal(
        await inviteService.resolveUserCampaignRole(TENANT_ALPHA, USER_ALPHA_OWNER),
        'owner'
      );
      assert.equal(
        await inviteService.resolveUserCampaignRole(TENANT_BETA, USER_ALPHA_OWNER),
        null
      );

      // USER_DUAL is manager on Alpha, viewer on Beta
      assert.equal(await inviteService.resolveUserCampaignRole(TENANT_ALPHA, USER_DUAL), 'manager');
      assert.equal(await inviteService.resolveUserCampaignRole(TENANT_BETA, USER_DUAL), 'viewer');

      // Stranger has null role on both
      assert.equal(await inviteService.resolveUserCampaignRole(TENANT_ALPHA, USER_STRANGER), null);
      assert.equal(await inviteService.resolveUserCampaignRole(TENANT_BETA, USER_STRANGER), null);
    });

    test('countAcceptedOwners counts owners exclusively within the specified tenant', async () => {
      const { inviteService } = buildTestEnvironment();

      // Tenant Alpha has 1 accepted member with role 'owner' + creator = max(1, 1) = 1
      const countAlpha = await inviteService.countAcceptedOwners(TENANT_ALPHA);
      assert.equal(countAlpha, 1);

      // Tenant Beta has 1 accepted member with role 'owner' + creator = max(1, 1) = 1
      const countBeta = await inviteService.countAcceptedOwners(TENANT_BETA);
      assert.equal(countBeta, 1);

      // Nonexistent campaign returns 0
      const countMissing = await inviteService.countAcceptedOwners(NON_EXISTENT_TENANT);
      assert.equal(countMissing, 0);
    });

    test('createCampaignInvite allows inviting a user to Tenant Alpha who is already an accepted member of Tenant Beta', async () => {
      const { inviteService } = buildTestEnvironment();

      // USER_BETA_OWNER is an accepted member on Beta, but NOT on Alpha
      const result = await inviteService.createCampaignInvite({
        campaignId: TENANT_ALPHA,
        email: 'beta-owner@example.com',
        role: 'editor',
        invitedByUserId: USER_ALPHA_OWNER,
        campaignTitle: 'Campaign Alpha',
      });

      assert.equal(result.member.campaign_id, TENANT_ALPHA);
      assert.equal(result.member.email, 'beta-owner@example.com');
      assert.equal(result.member.role, 'editor');
    });

    test('createCampaignInvite rejects inviting a user who is ALREADY an accepted member in the SAME tenant', async () => {
      const { inviteService } = buildTestEnvironment();

      await assert.rejects(
        inviteService.createCampaignInvite({
          campaignId: TENANT_ALPHA,
          email: 'alpha-owner@example.com',
          role: 'viewer',
          invitedByUserId: USER_ALPHA_OWNER,
          campaignTitle: 'Campaign Alpha',
        }),
        err => err.statusCode === 409 && /already a member/i.test(err.message)
      );
    });

    test('resendCampaignInvite rejects cross-tenant member ID with 404', async () => {
      const { inviteService } = buildTestEnvironment();

      // Pass INVITE_BETA_ID but specify TENANT_ALPHA
      await assert.rejects(
        inviteService.resendCampaignInvite({
          memberId: INVITE_BETA_ID,
          campaignId: TENANT_ALPHA,
          campaignTitle: 'Campaign Alpha',
        }),
        err => err.statusCode === 404 && /pending invitation not found/i.test(err.message)
      );
    });

    test('cancelCampaignInvite rejects cross-tenant member ID with 404', async () => {
      const { inviteService } = buildTestEnvironment();

      // Pass INVITE_BETA_ID but specify TENANT_ALPHA
      await assert.rejects(
        inviteService.cancelCampaignInvite({
          memberId: INVITE_BETA_ID,
          campaignId: TENANT_ALPHA,
        }),
        err => err.statusCode === 404 && /pending invitation not found/i.test(err.message)
      );
    });
  });
});
