const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const VALID_DESTINATION = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';
const MILESTONE_ID = '22222222-2222-2222-2222-222222222222';

function milestoneRow(overrides = {}) {
  return {
    id: MILESTONE_ID,
    campaign_id: '11111111-1111-1111-1111-111111111111',
    creator_id: 'creator-1',
    campaign_status: 'funded',
    campaign_title: 'Test Campaign',
    title: 'Milestone 1',
    status: 'pending',
    sort_order: 0,
    release_percentage: '50.0000',
    raised_amount: '1000',
    evidence_url: null,
    destination_key: null,
    ...overrides,
  };
}

function buildApp({
  queryImpl,
  userId = 'creator-1',
  role = 'creator',
  platformApproverUserId,
} = {}) {
  const prevApprover = process.env.PLATFORM_APPROVER_USER_ID;
  const prevSetImmediate = global.setImmediate;
  global.setImmediate = fn => {
    fn();
  };
  if (platformApproverUserId !== false) {
    process.env.PLATFORM_APPROVER_USER_ID = platformApproverUserId ?? 'platform-1';
  }

  const stellarStub = {
    buildWithdrawalTransaction: async () => 'xdr-base',
    signTransactionXdr: () => 'xdr-signed',
    signatureCountFromXdr: () => 2,
    submitSignedWithdrawal: async () => 'tx-hash',
  };

  const router = proxyquire('./milestones', {
    '../config/database': {
      connect: async () => ({
        query: queryImpl,
        release: () => {},
      }),
      query: queryImpl,
    },
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    '../services/stellarService': stellarStub,
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => {},
      finalizeWithdrawalSubmitted: async () => {},
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SCREATOR'),
    },
    '../services/storage': {
      uploadMilestoneEvidence: async () => 'https://cdn.example.com/evidence.pdf',
      parseMilestoneEvidenceUrl: () => null,
      milestoneEvidenceExists: async () => false,
    },
    '../services/auditService': {
      logAuditEvent: async () => ({}),
    },
    '../services/notifications': {
      createNotification: async () => {},
    },
    '../services/emailService': {
      sendMilestoneReleasedCreatorEmail: async () => {},
      sendMilestoneReleasedContributorEmail: async () => {},
      sendMilestoneEvidenceSubmittedAdminEmail: async () => {},
    },
    '../services/sorobanService': {
      invokeContract: async () => {},
      releaseMilestone: async () => {},
      nativeToScVal: v => v,
    },
    '../services/campaignInviteService': {
      resolveUserCampaignRole: async () => null,
    },
    '../lib/campaignPermissions': {
      canSubmitMilestones: () => false,
    },
    '../services/alerting': {
      sendAlert: () => {},
    },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      WEBHOOK_EVENTS: {
        MILESTONE_REJECTED: 'milestone.rejected',
        MILESTONE_APPROVED: 'milestone.approved',
      },
    },
    '../services/campaignFollowService': {
      notifyFollowers: async () => {},
    },
    '../services/fraudService': {
      evaluateCampaign: async () => {},
    },
    '../services/fundReleaseNotifications': {
      notifyContributorFundRelease: async () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId, role };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/milestones', router);

  return {
    app,
    cleanup: () => {
      global.setImmediate = prevSetImmediate;
      if (prevApprover === undefined) delete process.env.PLATFORM_APPROVER_USER_ID;
      else process.env.PLATFORM_APPROVER_USER_ID = prevApprover;
    },
  };
}

test('POST /api/milestones/:id/submit transitions milestone to pending_review', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text, params) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return { rows: [milestoneRow()] };
      }
      if (text.includes('UPDATE milestones') && text.includes('pending_review')) {
        return {
          rows: [
            milestoneRow({
              status: 'pending_review',
              evidence_url: params[0],
              evidence_description: params[1],
              destination_key: params[2],
              evidence_submitted_at: new Date().toISOString(),
            }),
          ],
        };
      }
      if (text.includes('INSERT INTO milestone_events')) return { rows: [] };
      if (text.includes("SELECT id, email, name FROM users WHERE role = 'admin'"))
        return { rows: [] };
      if (text.includes('SELECT name FROM users WHERE id')) return { rows: [{ name: 'Creator' }] };
      if (text.includes('milestones_contract_id'))
        return { rows: [{ milestones_contract_id: null }] };
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/milestones/${MILESTONE_ID}/submit`).send({
    evidence_url: 'https://example.com/demo',
    evidence_description: 'Shipped beta build',
    destination_key: VALID_DESTINATION,
  });

  cleanup();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending_review');
  assert.ok(calls.some(c => c.includes('pending_review')));
  assert.ok(calls.some(c => c.includes('INSERT INTO milestone_events')));
});

test('POST /api/milestones/:id/submit blocks when already pending_review', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return {
          rows: [milestoneRow({ status: 'pending_review', evidence_url: 'https://x.test' })],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/submit`)
    .send({ evidence_url: 'https://example.com/demo', destination_key: VALID_DESTINATION });

  cleanup();
  assert.equal(res.status, 409);
  assert.match(res.body.error, /awaiting platform review/i);
});

test('POST /api/milestones/:id/submit is blocked while the campaign contract is being migrated', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return { rows: [milestoneRow({ migration_in_progress: true })] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/submit`)
    .send({ evidence_url: 'https://example.com/demo', destination_key: VALID_DESTINATION });

  cleanup();
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'CAMPAIGN_MIGRATION_IN_PROGRESS');
});

test('POST /api/milestones/:id/approve requires pending_review status', async () => {
  const { app, cleanup } = buildApp({
    userId: 'platform-1',
    role: 'admin',
    platformApproverUserId: 'platform-1',
    queryImpl: async text => {
      if (text.includes('SELECT role, is_admin FROM users WHERE id')) {
        return { rows: [{ role: 'admin', is_admin: true }] };
      }
      if (text.includes('FROM milestones m') && text.includes('JOIN users u')) {
        return {
          rows: [
            milestoneRow({
              status: 'pending',
              evidence_url: 'https://x.test',
              destination_key: VALID_DESTINATION,
            }),
          ],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/milestones/${MILESTONE_ID}/approve`).send({});

  cleanup();
  assert.equal(res.status, 409);
  assert.match(res.body.error, /pending_review/i);
});

test('POST /api/milestones/:id/reject sets rejected status with reason', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    userId: 'platform-1',
    role: 'admin',
    platformApproverUserId: 'platform-1',
    queryImpl: async (text, params) => {
      calls.push(text);
      if (text.includes('SELECT role, is_admin FROM users WHERE id')) {
        return { rows: [{ role: 'admin', is_admin: true }] };
      }
      if (text.includes('UPDATE milestones') && text.includes('rejected')) {
        return {
          rows: [
            milestoneRow({
              status: 'rejected',
              review_note: params[0],
              campaign_id: milestoneRow().campaign_id,
              sort_order: 0,
            }),
          ],
        };
      }
      if (text.includes('INSERT INTO milestone_events')) return { rows: [] };
      if (text.includes('milestones_contract_id'))
        return { rows: [{ milestones_contract_id: null }] };
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/milestones/${MILESTONE_ID}/reject`)
    .send({ reason: 'Evidence does not match deliverable' });

  cleanup();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'rejected');
  assert.equal(res.body.review_note, 'Evidence does not match deliverable');
  assert.ok(calls.some(c => c.includes('rejected')));
});

test('POST /api/milestones/:id/approve prevents concurrent approval via atomic claim', async () => {
  let claimCount = 0;
  const calls = [];
  const { app, cleanup } = buildApp({
    userId: 'platform-1',
    role: 'admin',
    platformApproverUserId: 'platform-1',
    queryImpl: async (text, params) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT role, is_admin FROM users WHERE id')) {
        return { rows: [{ role: 'admin', is_admin: true }] };
      }
      if (text.includes('FROM milestones m') && text.includes('JOIN users u')) {
        return {
          rows: [
            milestoneRow({
              status: 'pending_review',
              evidence_url: 'https://x.test',
              destination_key: VALID_DESTINATION,
              wallet_secret_encrypted: 'enc',
              creator_wallet_public_key: 'GCREATOR',
              campaign_wallet_public_key: 'GCAMPAIGN',
              asset_type: 'USDC',
              raised_amount: '1000',
              target_amount: '1000',
            }),
          ],
        };
      }
      if (text.includes('COUNT(*) FILTER') && text.includes('milestone_votes')) {
        return { rows: [{ approve_count: 0, reject_count: 0, total_votes: 0 }] };
      }
      if (text.includes('UPDATE milestones') && text.includes('claimed_at')) {
        claimCount++;
        if (claimCount > 1) {
          // Second claim attempt fails — already claimed
          return { rows: [] };
        }
        return { rows: [{ id: MILESTONE_ID }] };
      }
      if (text.includes('UPDATE milestones') && text.includes("status = 'released'")) {
        return { rows: [milestoneRow({ status: 'released' })] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        return { rows: [{ id: 'w-rel-1', status: 'submitted' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      if (text.includes('INSERT INTO stellar_transactions')) return { rows: [] };
      if (text.includes('INSERT INTO milestone_events')) return { rows: [] };
      if (text.includes('SELECT id FROM withdrawal_requests WHERE milestone_id')) {
        return { rows: [] };
      }
      if (text.includes('milestones_contract_id'))
        return { rows: [{ milestones_contract_id: null }] };
      if (text.includes('COUNT(*)::int AS total')) {
        return { rows: [{ total: 1, released_count: 1 }] };
      }
      return { rows: [] };
    },
  });

  // First request should succeed
  const res1 = await request(app).post(`/api/milestones/${MILESTONE_ID}/approve`).send({});

  // Second request should be blocked because milestone is already claimed
  const res2 = await request(app).post(`/api/milestones/${MILESTONE_ID}/approve`).send({});

  cleanup();
  assert.equal(res1.status, 200, 'first approval should succeed');
  assert.equal(res2.status, 409, 'second concurrent approval should be blocked');
  assert.match(res2.body.error, /already being processed|already claimed/i);
});

test('POST /api/milestones/:id/submit rejects javascript: scheme in evidence_url', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return { rows: [milestoneRow()] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/milestones/${MILESTONE_ID}/submit`).send({
    evidence_url: 'javascript:alert(1)',
    destination_key: VALID_DESTINATION,
  });

  cleanup();
  assert.equal(res.status, 422);
  assert.match(res.body.error, /evidence_url is not valid/i);
});

test('POST /api/milestones/:id/submit rejects data: scheme in evidence_url', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return { rows: [milestoneRow()] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/milestones/${MILESTONE_ID}/submit`).send({
    evidence_url: 'data:text/html,<script>alert(1)</script>',
    destination_key: VALID_DESTINATION,
  });

  cleanup();
  assert.equal(res.status, 422);
  assert.match(res.body.error, /evidence_url is not valid/i);
});

test('POST /api/milestones/:id/submit rejects malformed URL', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return { rows: [milestoneRow()] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/milestones/${MILESTONE_ID}/submit`).send({
    evidence_url: 'not-a-valid-url',
    destination_key: VALID_DESTINATION,
  });

  cleanup();
  assert.equal(res.status, 422);
  assert.match(res.body.error, /evidence_url is not valid/i);
});

test('POST /api/milestones/:id/submit rejects vbscript: scheme', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
        return { rows: [milestoneRow()] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post(`/api/milestones/${MILESTONE_ID}/submit`).send({
    evidence_url: 'vbscript:MsgBox("XSS")',
    destination_key: VALID_DESTINATION,
  });

  cleanup();
  assert.equal(res.status, 422);
  assert.match(res.body.error, /evidence_url is not valid/i);
});

// ─── Automatic release configuration (#930) ──────────────────────────

function autoReleaseQuery({ milestone, onUpdate } = {}) {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('FROM milestones m') && text.includes('JOIN campaigns')) {
      return { rows: milestone ? [milestone] : [] };
    }
    if (text.includes('UPDATE milestones') && text.includes('auto_release_enabled')) {
      return { rows: [onUpdate ? onUpdate(params) : { ...milestone }] };
    }
    if (text.includes('INSERT INTO milestone_events')) return { rows: [] };
    return { rows: [] };
  };
  return { calls, queryImpl };
}

test('PUT /api/milestones/:id/auto-release enforces the minimum dispute window', async () => {
  const { calls, queryImpl } = autoReleaseQuery({ milestone: milestoneRow() });
  const { app, cleanup } = buildApp({ queryImpl });
  try {
    const res = await request(app)
      .put(`/api/milestones/${MILESTONE_ID}/auto-release`)
      .send({ enabled: true, rule: 'platform_evidence', dispute_window_hours: 12 });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'DISPUTE_WINDOW_BELOW_MINIMUM');
    assert.equal(res.body.min_window_seconds, 24 * 3600);
    assert.ok(!calls.some(c => c.text.includes('UPDATE milestones')), 'nothing is written');
  } finally {
    cleanup();
  }
});

test('PUT /api/milestones/:id/auto-release refuses to remove the dispute window', async () => {
  const { queryImpl } = autoReleaseQuery({ milestone: milestoneRow() });
  const { app, cleanup } = buildApp({ queryImpl });
  try {
    const res = await request(app)
      .put(`/api/milestones/${MILESTONE_ID}/auto-release`)
      .send({ enabled: true, rule: 'platform_evidence', dispute_window_hours: 0 });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'DISPUTE_WINDOW_REQUIRED');
  } finally {
    cleanup();
  }
});

test('PUT /api/milestones/:id/auto-release records the rule and window on the milestone', async () => {
  const { calls, queryImpl } = autoReleaseQuery({
    milestone: milestoneRow(),
    onUpdate: params =>
      milestoneRow({
        auto_release_enabled: true,
        auto_release_rule: params[1],
        auto_release_rule_config: JSON.parse(params[2]),
        auto_release_window_seconds: params[3],
        auto_release_status: 'awaiting_evidence',
      }),
  });
  const { app, cleanup } = buildApp({ queryImpl });
  try {
    const sha256 = 'f'.repeat(64);
    const res = await request(app).put(`/api/milestones/${MILESTONE_ID}/auto-release`).send({
      enabled: true,
      rule: 'evidence_hash_commitment',
      rule_config: { sha256 },
      dispute_window_hours: 48,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.rule, 'evidence_hash_commitment');
    assert.deepEqual(res.body.rule_config, { sha256 });
    assert.equal(res.body.dispute_window_seconds, 48 * 3600);
    assert.equal(res.body.status, 'awaiting_evidence');

    const event = calls.find(c => c.text.includes('INSERT INTO milestone_events'));
    assert.equal(event.params[2], 'auto_release_configured');
    assert.equal(JSON.parse(event.params[4]).rule, 'evidence_hash_commitment');
  } finally {
    cleanup();
  }
});

test('PUT /api/milestones/:id/auto-release is locked once evidence is submitted', async () => {
  const { queryImpl } = autoReleaseQuery({ milestone: milestoneRow({ status: 'pending_review' }) });
  const { app, cleanup } = buildApp({ queryImpl });
  try {
    const res = await request(app)
      .put(`/api/milestones/${MILESTONE_ID}/auto-release`)
      .send({ enabled: true, rule: 'platform_evidence' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'AUTO_RELEASE_LOCKED');
  } finally {
    cleanup();
  }
});

test('PUT /api/milestones/:id/auto-release is creator-only', async () => {
  const { queryImpl } = autoReleaseQuery({ milestone: milestoneRow() });
  const { app, cleanup } = buildApp({ queryImpl, userId: 'someone-else' });
  try {
    const res = await request(app)
      .put(`/api/milestones/${MILESTONE_ID}/auto-release`)
      .send({ enabled: true, rule: 'platform_evidence' });
    assert.equal(res.status, 403);
  } finally {
    cleanup();
  }
});

test('GET /api/milestones/:id/auto-release shows backers the pending release and countdown', async () => {
  const firesAt = new Date(Date.now() + 5 * 3600 * 1000);
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM milestones WHERE id')) {
        return {
          rows: [
            milestoneRow({
              status: 'pending_review',
              evidence_url: 'https://storage.test/evidence/x',
              evidence_description: 'Release notes and build',
              auto_release_enabled: true,
              auto_release_rule: 'platform_evidence',
              auto_release_rule_config: {},
              auto_release_window_seconds: 72 * 3600,
              auto_release_status: 'scheduled',
              auto_release_at: firesAt,
              auto_release_evidence_url: 'https://storage.test/evidence/x',
              auto_release_evidence_sha256: 'a'.repeat(64),
            }),
          ],
        };
      }
      return { rows: [] };
    },
  });
  try {
    const res = await request(app).get(`/api/milestones/${MILESTONE_ID}/auto-release`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'scheduled');
    assert.equal(res.body.can_dispute, true);
    assert.ok(res.body.seconds_remaining > 4 * 3600 && res.body.seconds_remaining <= 5 * 3600);
    assert.equal(res.body.evidence.url, 'https://storage.test/evidence/x');
    assert.equal(res.body.evidence.description, 'Release notes and build');
  } finally {
    cleanup();
  }
});

test('POST /api/milestones with auto_release still enforces the 100% milestone total', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async text => {
      if (text.includes('FROM campaigns WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: 'campaign-1', creator_id: 'creator-1' }] };
      }
      if (text.includes('SUM(release_percentage)'))
        return { rows: [{ count: 1, total_percentage: '80' }] };
      if (text.includes('INSERT INTO milestones')) throw new Error('must not insert');
      return { rows: [] };
    },
  });
  try {
    const res = await request(app)
      .post('/api/milestones')
      .send({
        campaign_id: 'campaign-1',
        title: 'Auto milestone',
        release_percentage: 30,
        auto_release: { enabled: true, rule: 'platform_evidence' },
      });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must not exceed 100%/);
  } finally {
    cleanup();
  }
});

test('POST /api/milestones rejects an auto_release config below the minimum window', async () => {
  const { app, cleanup } = buildApp({ queryImpl: async () => ({ rows: [] }) });
  try {
    const res = await request(app)
      .post('/api/milestones')
      .send({
        campaign_id: 'campaign-1',
        title: 'Auto milestone',
        release_percentage: 30,
        auto_release: { enabled: true, rule: 'platform_evidence', dispute_window_hours: 1 },
      });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'DISPUTE_WINDOW_BELOW_MINIMUM');
  } finally {
    cleanup();
  }
});
