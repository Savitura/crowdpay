const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-32-chars-long-123456';

describe('Structured Audit Context for Administrative Moderation Actions', () => {
  let auditLogsRows;
  let adminActionsRows;

  beforeEach(() => {
    auditLogsRows = [];
    adminActionsRows = [];
  });

  function createTestApp({
    user = { userId: 'admin-uuid-1', email: 'admin@crowdpay.org', is_admin: true, role: 'admin' },
    campaignData = null,
    userData = null,
    flaggedFraudData = null,
  } = {}) {
    const mockDb = {
      query: async (sql, params = []) => {
        // Audit log insert
        if (sql.includes('INSERT INTO audit_logs')) {
          const entry = {
            id: 'audit-' + (auditLogsRows.length + 1),
            actor_id: params[0],
            action: params[1],
            resource_type: params[2],
            resource_id: params[3],
            ip_address: params[4],
            user_agent: params[5],
            metadata: JSON.parse(params[6] || '{}'),
            correlation_id: params[7],
            source: params[8],
            before_state: JSON.parse(params[9] || '{}'),
            after_state: JSON.parse(params[10] || '{}'),
            created_at: new Date(),
          };
          auditLogsRows.push(entry);
          return { rows: [entry] };
        }

        // Admin actions insert
        if (sql.includes('INSERT INTO admin_actions')) {
          const entry = {
            id: 'action-' + (adminActionsRows.length + 1),
            admin_user_id: params[0],
            action_type: params[1],
            target_type: params[2],
            target_id: params[3],
            details: JSON.parse(params[4] || '{}'),
            created_at: new Date(),
          };
          adminActionsRows.push(entry);
          return { rows: [entry] };
        }

        // Campaign queries
        if (sql.includes('FROM campaigns WHERE id = $1')) {
          if (!campaignData) return { rows: [] };
          return { rows: [campaignData] };
        }
        if (
          sql.includes('UPDATE campaigns SET status =') ||
          sql.includes('UPDATE campaigns SET deleted_at =')
        ) {
          return {
            rows: [
              {
                id: campaignData?.id || params[0],
                title: campaignData?.title || 'Test Campaign',
                status: sql.includes("'suspended'") ? 'suspended' : 'active',
                deleted_at: sql.includes('deleted_at') ? new Date() : null,
                created_at: new Date(),
              },
            ],
          };
        }

        // User queries
        if (sql.includes('SELECT id, email') && sql.includes('FROM users WHERE id = $1')) {
          if (!userData) return { rows: [] };
          return { rows: [userData] };
        }
        if (
          sql.includes('UPDATE users SET is_banned =') ||
          sql.includes('UPDATE users SET kyc_status =')
        ) {
          return {
            rows: [
              {
                id: userData?.id || params[0],
                email: userData?.email || 'user@example.com',
                name: userData?.name || 'Target User',
                is_banned: sql.includes('is_banned = true'),
                kyc_status: params[1] || 'verified',
                kyc_completed_at: new Date(),
              },
            ],
          };
        }

        // Admin actions list
        if (sql.includes('SELECT COUNT(*) FROM admin_actions')) {
          return { rows: [{ count: adminActionsRows.length }] };
        }
        if (sql.includes('FROM admin_actions a')) {
          return {
            rows: adminActionsRows.map(a => ({
              ...a,
              admin_email: user.email,
            })),
          };
        }

        return { rows: [] };
      },
    };

    const auditServiceMock = proxyquire('../services/auditService', {
      '../config/database': mockDb,
      '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    });

    const moderationAuditServiceMock = proxyquire('../services/moderationAuditService', {
      '../config/database': mockDb,
      '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
      './auditService': auditServiceMock,
    });

    const adminRouter = proxyquire('./admin', {
      '../config/database': mockDb,
      '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
      '../utils/cache': { invalidatePrefix: () => {} },
      '../services/stellarService': {
        revokeAndCloseCampaignWallet: async () => {},
      },
      '../services/auditService': auditServiceMock,
      '../services/moderationAuditService': moderationAuditServiceMock,
      '../services/fraudService': {
        resolveFlaggedContribution: async ({ contributionId, resolution }) => ({
          id: contributionId,
          status: resolution,
        }),
        getFraudDashboard: async () => [],
        retrainModel: async () => ({ success: true }),
      },
      '../middleware/auth': {
        requireAuth: (req, _res, next) => {
          req.user = user;
          next();
        },
        requireAdmin: (req, res, next) => {
          if (!req.user?.is_admin) return res.status(403).json({ error: 'Forbidden' });
          next();
        },
        IMPERSONATION_TOKEN_COOKIE_NAME: 'test_impersonation_token',
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.id = 'req-trace-999';
      next();
    });
    app.use('/api/admin', adminRouter);
    return app;
  }

  it('campaign suspension captures structured audit context in both audit_logs and admin_actions', async () => {
    const app = createTestApp({
      campaignData: {
        id: 'camp-101',
        title: 'Solar Community Grid',
        status: 'active',
        creator_id: 'creator-uuid-5',
        is_flagged_fraud: false,
      },
    });

    const res = await request(app)
      .patch('/api/admin/campaigns/camp-101/suspend')
      .send({ reason: 'Misleading milestone evidence submitted' });

    assert.equal(res.status, 200);
    assert.equal(res.body.campaign.status, 'suspended');

    // Verify audit_logs (append-only privileged audit event)
    assert.equal(auditLogsRows.length, 1);
    const auditEvent = auditLogsRows[0];
    assert.equal(auditEvent.action, 'campaign.suspended');
    assert.equal(auditEvent.resource_type, 'campaign');
    assert.equal(auditEvent.resource_id, 'camp-101');
    assert.equal(auditEvent.actor_id, 'admin-uuid-1');
    assert.equal(auditEvent.correlation_id, 'req-trace-999');
    assert.equal(auditEvent.before_state.status, 'active');
    assert.equal(auditEvent.before_state.title, 'Solar Community Grid');
    assert.equal(auditEvent.after_state.status, 'suspended');
    assert.equal(auditEvent.metadata.reason, 'Misleading milestone evidence submitted');
    assert.equal(auditEvent.metadata.campaign_title, 'Solar Community Grid');

    // Verify admin_actions (moderation action history)
    assert.equal(adminActionsRows.length, 1);
    const actionEntry = adminActionsRows[0];
    assert.equal(actionEntry.action_type, 'suspend');
    assert.equal(actionEntry.target_type, 'campaign');
    assert.equal(actionEntry.target_id, 'camp-101');
    assert.equal(actionEntry.details.reason, 'Misleading milestone evidence submitted');
    assert.equal(actionEntry.details.campaign_title, 'Solar Community Grid');
    assert.equal(actionEntry.details.before.status, 'active');
    assert.equal(actionEntry.details.after.status, 'suspended');
    assert.equal(actionEntry.details.actor_email, 'admin@crowdpay.org');
    assert.equal(actionEntry.details.correlation_id, 'req-trace-999');
  });

  it('campaign restoration captures structured audit context with previous suspended state', async () => {
    const app = createTestApp({
      campaignData: {
        id: 'camp-102',
        title: 'Clean Water Initiative',
        status: 'suspended',
        creator_id: 'creator-uuid-7',
      },
    });

    const res = await request(app)
      .patch('/api/admin/campaigns/camp-102/restore')
      .send({ reason: 'Evidence verified upon manual review' });

    assert.equal(res.status, 200);
    assert.equal(res.body.campaign.status, 'active');

    assert.equal(auditLogsRows.length, 1);
    assert.equal(auditLogsRows[0].action, 'campaign.restored');
    assert.equal(auditLogsRows[0].resource_type, 'campaign');
    assert.equal(auditLogsRows[0].resource_id, 'camp-102');
    assert.equal(auditLogsRows[0].before_state.status, 'suspended');
    assert.equal(auditLogsRows[0].after_state.status, 'active');
    assert.equal(auditLogsRows[0].metadata.campaign_title, 'Clean Water Initiative');

    assert.equal(adminActionsRows.length, 1);
    assert.equal(adminActionsRows[0].action_type, 'restore');
    assert.equal(adminActionsRows[0].details.campaign_title, 'Clean Water Initiative');
    assert.equal(adminActionsRows[0].details.reason, 'Evidence verified upon manual review');
  });

  it('campaign deletion captures wallet status and creator details in structured audit context', async () => {
    const app = createTestApp({
      campaignData: {
        id: 'camp-103',
        title: 'Fraudulent Medical Campaign',
        status: 'active',
        creator_id: 'creator-bad-actor',
        wallet_public_key: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        wallet_secret_encrypted: 'encrypted-secret-blob',
      },
    });

    const res = await request(app)
      .delete('/api/admin/campaigns/camp-103')
      .send({ reason: 'Violates platform terms - counterfeit recipient identity' });

    assert.equal(res.status, 200);
    assert.ok(res.body.campaign.deleted_at);

    assert.equal(auditLogsRows.length, 1);
    const audit = auditLogsRows[0];
    assert.equal(audit.action, 'campaign.deleted');
    assert.equal(audit.resource_type, 'campaign');
    assert.equal(audit.resource_id, 'camp-103');
    assert.equal(audit.metadata.reason, 'Violates platform terms - counterfeit recipient identity');
    assert.equal(audit.metadata.wallet_revoked, true);
    assert.equal(audit.metadata.creator_id, 'creator-bad-actor');

    assert.equal(adminActionsRows.length, 1);
    assert.equal(adminActionsRows[0].action_type, 'delete');
    assert.equal(adminActionsRows[0].details.wallet_revoked, true);
    assert.equal(adminActionsRows[0].details.creator_id, 'creator-bad-actor');
  });

  it('user ban captures email, reason, and prior ban status in structured audit context', async () => {
    const app = createTestApp({
      userData: {
        id: 'user-201',
        email: 'abusive.user@domain.com',
        name: 'Spam Bot',
        role: 'backer',
        is_banned: false,
      },
    });

    const res = await request(app)
      .patch('/api/admin/users/user-201/ban')
      .send({ reason: 'Repeated offensive comments across multiple campaigns' });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.is_banned, true);

    assert.equal(auditLogsRows.length, 1);
    const audit = auditLogsRows[0];
    assert.equal(audit.action, 'user.banned');
    assert.equal(audit.resource_type, 'user');
    assert.equal(audit.resource_id, 'user-201');
    assert.equal(audit.before_state.is_banned, false);
    assert.equal(audit.after_state.is_banned, true);
    assert.equal(audit.metadata.target_user_email, 'abusive.user@domain.com');
    assert.equal(audit.metadata.reason, 'Repeated offensive comments across multiple campaigns');

    assert.equal(adminActionsRows.length, 1);
    assert.equal(adminActionsRows[0].action_type, 'ban');
    assert.equal(adminActionsRows[0].target_id, 'user-201');
    assert.equal(adminActionsRows[0].details.target_user_email, 'abusive.user@domain.com');
  });

  it('user unban captures previous banned reason and structured delta', async () => {
    const app = createTestApp({
      userData: {
        id: 'user-202',
        email: 'appealed.user@domain.com',
        name: 'Appealed User',
        role: 'backer',
        is_banned: true,
        banned_reason: 'False positive duplicate account flag',
      },
    });

    const res = await request(app)
      .patch('/api/admin/users/user-202/unban')
      .send({ reason: 'Appeal reviewed and granted by trust & safety team' });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.is_banned, false);

    assert.equal(auditLogsRows.length, 1);
    const audit = auditLogsRows[0];
    assert.equal(audit.action, 'user.unbanned');
    assert.equal(audit.resource_type, 'user');
    assert.equal(audit.before_state.is_banned, true);
    assert.equal(audit.before_state.banned_reason, 'False positive duplicate account flag');
    assert.equal(audit.after_state.is_banned, false);
    assert.equal(audit.metadata.target_user_email, 'appealed.user@domain.com');
    assert.equal(audit.metadata.reason, 'Appeal reviewed and granted by trust & safety team');
  });

  it('user KYC override records previous status, new status, and justification', async () => {
    const app = createTestApp({
      userData: {
        id: 'user-203',
        email: 'creator.identity@domain.com',
        name: 'Validated Creator',
        kyc_status: 'pending',
      },
    });

    const res = await request(app)
      .patch('/api/admin/users/user-203/kyc')
      .send({ kyc_status: 'verified', reason: 'Government ID passport verified offline' });

    assert.equal(res.status, 200);

    assert.equal(auditLogsRows.length, 1);
    const audit = auditLogsRows[0];
    assert.equal(audit.action, 'user.kyc_override');
    assert.equal(audit.resource_type, 'user');
    assert.equal(audit.before_state.kyc_status, 'pending');
    assert.equal(audit.after_state.kyc_status, 'verified');
    assert.equal(audit.metadata.previous_status, 'pending');
    assert.equal(audit.metadata.new_status, 'verified');
    assert.equal(audit.metadata.reason, 'Government ID passport verified offline');

    assert.equal(adminActionsRows.length, 1);
    assert.equal(adminActionsRows[0].action_type, 'kyc_override');
    assert.equal(adminActionsRows[0].details.previous_status, 'pending');
    assert.equal(adminActionsRows[0].details.new_status, 'verified');
  });

  it('user impersonation start records target role, email, and rationale', async () => {
    const app = createTestApp({
      userData: {
        id: 'user-204',
        email: 'troubleshoot@user.com',
        name: 'Reported User',
        role: 'creator',
        is_admin: false,
        is_banned: false,
      },
    });

    const res = await request(app)
      .post('/api/admin/impersonate/user-204')
      .send({ reason: 'Investigating payout transaction stuck in escrow' });

    assert.equal(res.status, 201);
    assert.ok(res.body.token);

    assert.equal(auditLogsRows.length, 1);
    const audit = auditLogsRows[0];
    assert.equal(audit.action, 'admin.impersonate_start');
    assert.equal(audit.resource_type, 'user');
    assert.equal(audit.resource_id, 'user-204');
    assert.equal(audit.metadata.target_email, 'troubleshoot@user.com');
    assert.equal(audit.metadata.target_role, 'creator');
    assert.equal(audit.metadata.reason, 'Investigating payout transaction stuck in escrow');

    assert.equal(adminActionsRows.length, 1);
    assert.equal(adminActionsRows[0].action_type, 'impersonate_start');
    assert.equal(adminActionsRows[0].details.target_email, 'troubleshoot@user.com');
  });

  it('fraud resolution records decision and reason in structured audit trail', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/admin/fraud/contributions/contrib-888/resolve')
      .send({ resolution: 'approved', reason: 'Confirmed legitimate pledge with backer bank' });

    assert.equal(res.status, 200);

    assert.equal(auditLogsRows.length, 1);
    const audit = auditLogsRows[0];
    assert.equal(audit.action, 'fraud.contribution_resolved');
    assert.equal(audit.resource_type, 'contribution');
    assert.equal(audit.resource_id, 'contrib-888');
    assert.equal(audit.metadata.resolution, 'approved');
    assert.equal(audit.metadata.reason, 'Confirmed legitimate pledge with backer bank');
  });

  it('GET /api/admin/audit-log sanitizes sensitive credentials from details output', async () => {
    adminActionsRows.push({
      id: 'action-99',
      admin_user_id: 'admin-uuid-1',
      action_type: 'suspend',
      target_type: 'campaign',
      target_id: 'camp-99',
      details: {
        reason: 'Policy check',
        apiKey: 'cpk_live_super_secret_value',
        nested: { password: 'secretpassword123', safeNote: 'visible info' },
      },
      created_at: new Date(),
    });

    const app = createTestApp();
    const res = await request(app).get('/api/admin/audit-log');

    assert.equal(res.status, 200);
    assert.equal(res.body.actions.length, 1);
    const action = res.body.actions[0];
    assert.equal(action.details.reason, 'Policy check');
    assert.equal(action.details.apiKey, '[REDACTED]');
    assert.equal(action.details.nested.password, '[REDACTED]');
    assert.equal(action.details.nested.safeNote, 'visible info');
  });

  it('failed moderation action does not write audit rows', async () => {
    const app = createTestApp({
      campaignData: null, // Campaign not found -> 404
    });

    const res = await request(app)
      .patch('/api/admin/campaigns/non-existent-campaign/suspend')
      .send({ reason: 'Violates terms' });

    assert.equal(res.status, 404);
    assert.equal(auditLogsRows.length, 0);
    assert.equal(adminActionsRows.length, 0);
  });
});
