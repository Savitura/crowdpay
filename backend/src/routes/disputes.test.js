const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = 'cam-1';
const CONTRIBUTOR_ID = 'user-1';

function buildApp({ queryImpl, hasContributed = true, userId = CONTRIBUTOR_ID, stellarImpl = {}, sorobanImpl = {} } = {}) {
  const defaultQuery = async (sql, params) => {
    if (sql.includes('SELECT id, creator_id, title, wallet_public_key FROM campaigns')) {
      return {
        rows: [
          { id: CAMPAIGN_ID, creator_id: 'creator-1', title: 'Test Campaign', wallet_public_key: 'GCAMPAIGN' },
        ],
      };
    }
    if (sql.includes('FROM contributions')) {
      return { rows: hasContributed ? [{ id: 'contrib-1' }] : [] };
    }
    if (sql.includes("UPDATE campaigns SET status = 'disputed'")) {
      return { rows: [] };
    }
    if (sql.includes('UPDATE disputes SET frozen_at')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO disputes')) {
      const [campaignId, raisedBy, reason, description, evidenceUrl] = params;
      return {
        rows: [
          {
            id: 'dispute-1',
            campaign_id: campaignId,
            raised_by: raisedBy,
            reason,
            description,
            evidence_url: evidenceUrl,
            status: 'open',
          },
        ],
      };
    }
    if (sql.includes("SELECT email, name FROM users WHERE role = 'admin'")) {
      return { rows: [] };
    }
    if (sql.includes('SELECT previous_status FROM campaign_status_events')) {
      return { rows: [{ previous_status: 'active' }] };
    }
    return { rows: [] };
  };

  const query = queryImpl || defaultQuery;

  const router = proxyquire('./disputes', {
    '../config/database': {
      query,
      connect: async () => ({
        query,
        release: () => {},
      }),
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
    '../services/emailService': {
      sendDisputeOpenedCreatorEmail: async () => {},
      sendDisputeOpenedAdminEmail: async () => {},
      sendDisputeResolvedCreatorEmail: async () => {},
      sendDisputeResolvedContributorEmail: async () => {},
    },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      emitWebhookEventForCampaign: async () => {},
      WEBHOOK_EVENTS: { DISPUTE_RAISED: 'dispute.raised' },
    },
    '../services/stellarService': {
      freezeCampaignEscrow: async () => ({ hash: 'freeze-hash' }),
      releaseEscrowFreeze: async () => ({ hash: 'release-hash' }),
      submitDisputeRefund: async () => ({ hash: 'refund-hash', xdr: 'refund-xdr' }),
      getCampaignBalance: async () => ({ XLM: '0' }),
      ...stellarImpl,
    },
    '../services/sorobanService': {
      isRealSorobanContract: () => false,
      releaseEscrowToCreator: async () => 'soroban-tx-hash',
      ...sorobanImpl,
    },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

// --- evidence_url validation (#490) -----------------------------------------

test('POST /campaigns/:id/disputes returns 422 for an invalid reason', async () => {
  const app = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({ reason: 'made_up_reason', description: 'Something went wrong' });

  assert.equal(res.status, 422);
  assert.match(res.body.error, /reason must be one of/);
});

test('POST /campaigns/:id/disputes returns 422 for a missing description', async () => {
  const app = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({ reason: 'non_delivery', description: '   ' });

  assert.equal(res.status, 422);
  assert.match(res.body.error, /description is required/);
});

test('POST /campaigns/:id/disputes returns 422 for a malformed evidence_url', async () => {
  const app = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({
      reason: 'non_delivery',
      description: 'The item never arrived',
      evidence_url: 'not a url at all',
    });

  assert.equal(res.status, 422);
  assert.match(res.body.error, /evidence_url must be a valid/);
});

test('POST /campaigns/:id/disputes accepts a missing evidence_url', async () => {
  const app = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({ reason: 'non_delivery', description: 'The item never arrived' });

  assert.equal(res.status, 201);
});

test('POST /campaigns/:id/disputes accepts a valid https evidence_url', async () => {
  const app = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({
      reason: 'non_delivery',
      description: 'The item never arrived',
      evidence_url: 'https://example.com/proof.png',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.evidence_url, 'https://example.com/proof.png');
});

test('POST /campaigns/:id/disputes returns 403 for a non-contributor', async () => {
  const app = buildApp({ hasContributed: false });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({ reason: 'non_delivery', description: 'The item never arrived' });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_A_CONTRIBUTOR');
});

// --- escrow freeze (#674) ---------------------------------------------------

test('POST /campaigns/:id/disputes freezes escrow and returns frozenAt on success', async () => {
  const app = buildApp();

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({ reason: 'non_delivery', description: 'The item never arrived' });

  assert.equal(res.status, 201);
  assert.equal(res.body.disputeId, 'dispute-1');
  assert.ok(res.body.frozenAt);
});

test('POST /campaigns/:id/disputes still succeeds (frozenAt null) if the on-chain freeze fails', async () => {
  const app = buildApp({
    stellarImpl: {
      freezeCampaignEscrow: async () => {
        throw new Error('Horizon unreachable');
      },
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/disputes`)
    .send({ reason: 'non_delivery', description: 'The item never arrived' });

  assert.equal(res.status, 201);
  assert.equal(res.body.frozenAt, null);
});

// --- scoped dispute lookup (#674) -------------------------------------------

function buildLookupQuery({ raisedBy = CONTRIBUTOR_ID, creatorId = 'creator-1', hasOpenDispute = true } = {}) {
  return async (sql) => {
    if (sql.includes("d.status IN ('open', 'under_review')")) {
      return {
        rows: hasOpenDispute
          ? [{ id: 'dispute-1', campaign_id: CAMPAIGN_ID, raised_by: raisedBy, creator_id: creatorId, status: 'open' }]
          : [],
      };
    }
    return { rows: [] };
  };
}

test('GET /campaigns/:id/dispute returns the dispute for the disputing contributor', async () => {
  const app = buildApp({ queryImpl: buildLookupQuery() });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/dispute`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dispute.id, 'dispute-1');
});

test('GET /campaigns/:id/dispute returns the dispute for the campaign creator', async () => {
  const app = buildApp({ userId: 'creator-1', queryImpl: buildLookupQuery() });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/dispute`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dispute.id, 'dispute-1');
});

test('GET /campaigns/:id/dispute hides the dispute from unrelated users', async () => {
  const app = buildApp({ userId: 'stranger-1', queryImpl: buildLookupQuery() });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/dispute`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dispute, null);
});

test('GET /campaigns/:id/dispute returns null when there is no open dispute', async () => {
  const app = buildApp({ queryImpl: buildLookupQuery({ hasOpenDispute: false }) });
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/dispute`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dispute, null);
});

// --- evidence submission (#674) ---------------------------------------------

function buildEvidenceQuery({ raisedBy = CONTRIBUTOR_ID, creatorId = 'creator-1' } = {}) {
  return async (sql, params) => {
    if (sql.includes('FROM disputes d JOIN campaigns c')) {
      return { rows: [{ id: 'dispute-1', campaign_id: CAMPAIGN_ID, raised_by: raisedBy, creator_id: creatorId, status: 'open' }] };
    }
    if (sql.includes('INSERT INTO dispute_evidence')) {
      const [disputeId, submittedBy, role, text, attachmentUrls] = params;
      return { rows: [{ id: 'evidence-1', dispute_id: disputeId, submitted_by: submittedBy, role, text, attachment_urls: attachmentUrls }] };
    }
    if (sql.includes('INSERT INTO dispute_events')) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

test('POST /disputes/:id/evidence returns 422 for missing text', async () => {
  const app = buildApp({ queryImpl: buildEvidenceQuery() });

  const res = await request(app).post('/api/disputes/dispute-1/evidence').send({ attachmentUrls: [] });

  assert.equal(res.status, 422);
});

test('POST /disputes/:id/evidence returns 422 for an invalid attachment URL', async () => {
  const app = buildApp({ queryImpl: buildEvidenceQuery() });

  const res = await request(app)
    .post('/api/disputes/dispute-1/evidence')
    .send({ text: 'Here is my proof', attachmentUrls: ['not-a-url'] });

  assert.equal(res.status, 422);
});

test('POST /disputes/:id/evidence returns 403 for someone unrelated to the dispute', async () => {
  const app = buildApp({
    userId: 'stranger-1',
    queryImpl: buildEvidenceQuery({ raisedBy: CONTRIBUTOR_ID, creatorId: 'creator-1' }),
  });

  const res = await request(app).post('/api/disputes/dispute-1/evidence').send({ text: 'Not my dispute' });

  assert.equal(res.status, 403);
});

test('POST /disputes/:id/evidence accepts submission from the disputing contributor', async () => {
  const app = buildApp({ queryImpl: buildEvidenceQuery({ raisedBy: CONTRIBUTOR_ID }) });

  const res = await request(app)
    .post('/api/disputes/dispute-1/evidence')
    .send({ text: 'The item never showed up', attachmentUrls: ['https://example.com/tracking.png'] });

  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'contributor');
});

test('POST /disputes/:id/evidence accepts submission from the campaign creator', async () => {
  const app = buildApp({
    userId: 'creator-1',
    queryImpl: buildEvidenceQuery({ raisedBy: CONTRIBUTOR_ID, creatorId: 'creator-1' }),
  });

  const res = await request(app).post('/api/disputes/dispute-1/evidence').send({ text: 'It was delivered on time' });

  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'creator');
});

// --- admin decision (#674) ---------------------------------------------------

function buildDecideQuery({ contributorRows = [], escrowContractId = null } = {}) {
  return async (sql, params) => {
    if (sql.includes('FROM disputes d') && sql.includes('JOIN campaigns c') && sql.includes('creator_id')) {
      return {
        rows: [
          {
            id: 'dispute-1',
            campaign_id: CAMPAIGN_ID,
            creator_id: 'creator-1',
            wallet_public_key: 'GCAMPAIGN',
            escrow_contract_id: escrowContractId,
            raised_amount: '100.00',
            campaign_title: 'Test Campaign',
            creator_wallet_public_key: 'GCREATORWALLET',
            status: 'open',
          },
        ],
      };
    }
    if (sql.includes('SUM(c.amount) AS contributed')) {
      return { rows: contributorRows };
    }
    if (sql.includes('UPDATE disputes')) {
      const [decision, reason] = params;
      return { rows: [{ id: 'dispute-1', status: 'resolved', decision, resolution_note: reason }] };
    }
    if (sql.includes('INSERT INTO dispute_events')) return { rows: [] };
    if (sql.includes('SELECT previous_status FROM campaign_status_events')) {
      return { rows: [{ previous_status: 'active' }] };
    }
    if (sql.includes("UPDATE campaigns SET status")) return { rows: [] };
    if (sql.includes('UPDATE withdrawal_requests')) return { rows: [] };
    if (sql.includes('INSERT INTO withdrawal_requests')) return { rows: [] };
    if (sql.includes('SELECT id, email, name FROM users WHERE id = $1')) {
      return { rows: [{ id: 'creator-1', email: 'creator@example.com', name: 'Creator' }] };
    }
    if (sql.includes('WHERE id = ANY($1::uuid[])')) {
      return { rows: contributorRows.map((c) => ({ id: c.contributor_id, email: `${c.contributor_id}@example.com`, name: c.contributor_id })) };
    }
    return { rows: [] };
  };
}

test('POST /admin/disputes/:id/decide returns 422 for an invalid decision', async () => {
  const app = buildApp({ queryImpl: buildDecideQuery() });

  const res = await request(app).post('/api/admin/disputes/dispute-1/decide').send({ decision: 'do_nothing' });

  assert.equal(res.status, 422);
});

test('POST /admin/disputes/:id/decide release_to_creator releases the escrow freeze', async () => {
  let releaseCalled = false;
  const app = buildApp({
    queryImpl: buildDecideQuery(),
    stellarImpl: {
      releaseEscrowFreeze: async () => {
        releaseCalled = true;
        return { hash: 'release-hash' };
      },
    },
  });

  const res = await request(app)
    .post('/api/admin/disputes/dispute-1/decide')
    .send({ decision: 'release_to_creator', reason: 'Evidence supports the creator' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'resolved');
  assert.equal(releaseCalled, true);
});

test('POST /admin/disputes/:id/decide refund_contributors allocates proportional refunds summing to the balance', async () => {
  const contributorRows = [
    { contributor_id: 'contributor-a', wallet_public_key: 'GA', contributed: '10' },
    { contributor_id: 'contributor-b', wallet_public_key: 'GB', contributed: '90' },
  ];
  const app = buildApp({
    queryImpl: buildDecideQuery({ contributorRows }),
    stellarImpl: {
      getCampaignBalance: async () => ({ XLM: '100' }),
      submitDisputeRefund: async () => ({ hash: 'refund-hash', xdr: 'refund-xdr' }),
    },
  });

  const res = await request(app)
    .post('/api/admin/disputes/dispute-1/decide')
    .send({ decision: 'refund_contributors', reason: 'Contributor evidence is stronger' });

  assert.equal(res.status, 200);
  assert.equal(res.body.refunds.length, 2);
  const total = res.body.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  assert.equal(total.toFixed(7), '100.0000000');
});

// --- PATCH /disputes/:id resolution tests (#751) ----------------------------
// Tests for the dual-path release: multisig freeze release via stellarService
// + Soroban contract release via sorobanService (only when real contract + SOROBAN_ENABLED=true)

const DISPUTE_ID = 'dispute-1';
const ADMIN_ID = 'admin-1';

function buildAppForPatch({
  escrowContractId = null,
  campaignStatus = 'disputed',
  raisedAmount = '1000.00',
  arbitratorSignerAdded = true,
  sorobanEnabled = 'true',
  releaseFreezeMock = async () => ({ hash: 'freeze-release-hash' }),
  releaseFreezeShouldFail = false,
  sorobanReleaseMock = async () => 'soroban-tx-hash',
  sorobanReleaseShouldFail = false,
  freezeReleaseCalled = { count: 0 },
  sorobanReleaseCalled = { count: 0 },
} = {}) {
  const queries = [];
  const rollbackCalled = { value: false };
  const originalSorobanEnabled = process.env.SOROBAN_ENABLED;

  process.env.SOROBAN_ENABLED = sorobanEnabled;

  const queryImpl = async (sql, params) => {
    queries.push({ sql, params });

    if (sql.includes('SELECT * FROM disputes WHERE id')) {
      return {
        rows: [{
          id: DISPUTE_ID,
          campaign_id: CAMPAIGN_ID,
          raised_by: CONTRIBUTOR_ID,
          status: 'under_review',
          reason: 'non_delivery',
          description: 'Test dispute',
          arbitrator_signer_added: arbitratorSignerAdded,
        }],
      };
    }

    if (sql.includes('SELECT c.id, c.creator_id, c.wallet_public_key, c.escrow_contract_id')) {
      return {
        rows: [{
          id: CAMPAIGN_ID,
          creator_id: 'creator-1',
          wallet_public_key: 'GCREATOR...',
          escrow_contract_id: escrowContractId,
          raised_amount: raisedAmount,
          title: 'Test Campaign',
          campaign_status: campaignStatus,
          creator_wallet_public_key: 'GCREATORWALLET...',
        }],
      };
    }

    if (sql.includes('UPDATE disputes')) {
      return {
        rows: [{
          id: DISPUTE_ID,
          campaign_id: CAMPAIGN_ID,
          raised_by: CONTRIBUTOR_ID,
          status: params[0],
          resolution_note: params[1],
        }],
      };
    }

    if (sql.includes('INSERT INTO dispute_events')) {
      return { rows: [] };
    }

    if (sql.includes('UPDATE withdrawal_requests')) {
      return { rows: [] };
    }

    if (sql.includes('UPDATE campaigns SET status')) {
      return { rows: [] };
    }

    if (sql.includes('SELECT previous_status FROM campaign_status_events')) {
      return { rows: [{ previous_status: 'active' }] };
    }

    if (sql.includes('SELECT u.email, u.name, c.title')) {
      return {
        rows: [{
          email: 'creator@example.com',
          name: 'Creator',
          title: 'Test Campaign',
        }],
      };
    }

    if (sql.includes('SELECT wallet_public_key FROM campaigns')) {
      return { rows: [{ wallet_public_key: 'GCAMPAIGNWALLET...' }] };
    }

    if (sql.includes('SELECT wallet_public_key FROM users')) {
      return { rows: [{ wallet_public_key: 'GCONTRIBUTORWALLET...' }] };
    }

    if (sql.includes('SELECT id, amount, asset FROM contributions')) {
      return { rows: [] };
    }

    if (sql.includes('SELECT email, name FROM users WHERE id')) {
      return { rows: [{ email: 'user@example.com', name: 'User' }] };
    }

    if (sql.includes('SELECT title FROM campaigns')) {
      return { rows: [{ title: 'Test Campaign' }] };
    }

    return { rows: [] };
  };

  const releaseEscrowToCreatorMock = async (opts) => {
    sorobanReleaseCalled.count++;
    if (sorobanReleaseShouldFail) {
      throw new Error('Simulated Soroban escrow release failure');
    }
    return sorobanReleaseMock(opts);
  };

  const isRealSorobanContractMock = (contractId) => {
    if (!contractId) return false;
    return process.env.SOROBAN_ENABLED === 'true';
  };

  const releaseEscrowFreezeMock = async (opts) => {
    freezeReleaseCalled.count++;
    if (releaseFreezeShouldFail) {
      throw new Error('Simulated freeze release failure');
    }
    return releaseFreezeMock(opts);
  };

  const router = proxyquire('./disputes', {
    '../config/database': {
      query: queryImpl,
      connect: async () => ({
        query: async (sql, params) => {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT') return { rows: [] };
          if (sql === 'ROLLBACK') {
            rollbackCalled.value = true;
            return { rows: [] };
          }
          return queryImpl(sql, params);
        },
        release: () => {},
      }),
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: ADMIN_ID };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
    '../services/emailService': {
      sendDisputeOpenedCreatorEmail: async () => {},
      sendDisputeOpenedAdminEmail: async () => {},
      sendDisputeResolvedCreatorEmail: async () => {},
      sendDisputeResolvedContributorEmail: async () => {},
    },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      emitWebhookEventForCampaign: async () => {},
      WEBHOOK_EVENTS: {
        DISPUTE_OPENED: 'dispute.opened',
        DISPUTE_RESOLVED: 'dispute.resolved',
        WITHDRAWAL_UPDATED: 'withdrawal.updated',
      },
    },
    '../services/sorobanService': {
      releaseEscrowToCreator: releaseEscrowToCreatorMock,
      isRealSorobanContract: isRealSorobanContractMock,
    },
    '../services/stellarService': {
      buildWithdrawalTransaction: async () => 'mock-unsigned-xdr',
      releaseEscrowFreeze: releaseEscrowFreezeMock,
      freezeCampaignEscrow: async () => ({ hash: 'freeze-hash' }),
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => {},
    },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);

  const cleanup = () => {
    process.env.SOROBAN_ENABLED = originalSorobanEnabled;
  };

  return { app, queries, freezeReleaseCalled, sorobanReleaseCalled, rollbackCalled, cleanup };
}

test('PATCH /disputes/:id with resolved_creator calls freeze release when arbitrator_signer_added', async () => {
  const freezeReleaseCalled = { count: 0 };
  const sorobanReleaseCalled = { count: 0 };
  const { app, cleanup } = buildAppForPatch({
    escrowContractId: null,
    arbitratorSignerAdded: true,
    sorobanEnabled: 'false',
    freezeReleaseCalled,
    sorobanReleaseCalled,
  });

  try {
    const res = await request(app)
      .patch(`/api/disputes/${DISPUTE_ID}`)
      .send({ status: 'resolved_creator', resolution_note: 'Creator wins' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved_creator');
    assert.equal(freezeReleaseCalled.count, 1, 'releaseEscrowFreeze should be called for multisig freeze');
    assert.equal(sorobanReleaseCalled.count, 0, 'Soroban release should NOT be called without real contract');
  } finally {
    cleanup();
  }
});

test('PATCH /disputes/:id with resolved_creator calls BOTH freeze release AND Soroban release when real contract', async () => {
  const freezeReleaseCalled = { count: 0 };
  const sorobanReleaseCalled = { count: 0 };
  const { app, cleanup } = buildAppForPatch({
    escrowContractId: 'CESCROW123',
    arbitratorSignerAdded: true,
    sorobanEnabled: 'true',
    raisedAmount: '500.00',
    freezeReleaseCalled,
    sorobanReleaseCalled,
  });

  try {
    const res = await request(app)
      .patch(`/api/disputes/${DISPUTE_ID}`)
      .send({ status: 'resolved_creator', resolution_note: 'Creator wins' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved_creator');
    assert.equal(freezeReleaseCalled.count, 1, 'releaseEscrowFreeze should be called');
    assert.equal(sorobanReleaseCalled.count, 1, 'releaseEscrowToCreator should be called for real Soroban contract');
  } finally {
    cleanup();
  }
});

test('PATCH /disputes/:id with resolved_creator skips Soroban release when SOROBAN_ENABLED=false (mock ID)', async () => {
  const freezeReleaseCalled = { count: 0 };
  const sorobanReleaseCalled = { count: 0 };
  const { app, cleanup } = buildAppForPatch({
    escrowContractId: 'CMOCKCONTRACT123',
    arbitratorSignerAdded: true,
    sorobanEnabled: 'false',
    raisedAmount: '500.00',
    freezeReleaseCalled,
    sorobanReleaseCalled,
  });

  try {
    const res = await request(app)
      .patch(`/api/disputes/${DISPUTE_ID}`)
      .send({ status: 'resolved_creator', resolution_note: 'Creator wins' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved_creator');
    assert.equal(freezeReleaseCalled.count, 1, 'Freeze release should still be called');
    assert.equal(sorobanReleaseCalled.count, 0, 'Soroban release should be SKIPPED for mock contract ID');
  } finally {
    cleanup();
  }
});

test('PATCH /disputes/:id with resolved_contributor does NOT call any release', async () => {
  const freezeReleaseCalled = { count: 0 };
  const sorobanReleaseCalled = { count: 0 };
  const { app, cleanup } = buildAppForPatch({
    escrowContractId: 'CESCROW123',
    arbitratorSignerAdded: true,
    sorobanEnabled: 'true',
    raisedAmount: '500.00',
    freezeReleaseCalled,
    sorobanReleaseCalled,
  });

  try {
    const res = await request(app)
      .patch(`/api/disputes/${DISPUTE_ID}`)
      .send({ status: 'resolved_contributor', resolution_note: 'Contributor wins' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved_contributor');
    assert.equal(freezeReleaseCalled.count, 0, 'Freeze release should NOT be called for contributor resolution');
    assert.equal(sorobanReleaseCalled.count, 0, 'Soroban release should NOT be called for contributor resolution');
  } finally {
    cleanup();
  }
});

test('PATCH /disputes/:id rolls back transaction on freeze release failure', async () => {
  const freezeReleaseCalled = { count: 0 };
  const sorobanReleaseCalled = { count: 0 };
  const { app, rollbackCalled, cleanup } = buildAppForPatch({
    escrowContractId: null,
    arbitratorSignerAdded: true,
    sorobanEnabled: 'false',
    freezeReleaseCalled,
    sorobanReleaseCalled,
    releaseFreezeShouldFail: true,
  });

  try {
    const res = await request(app)
      .patch(`/api/disputes/${DISPUTE_ID}`)
      .send({ status: 'resolved_creator', resolution_note: 'Creator wins' });

    assert.equal(res.status, 500);
    assert.match(res.body.error, /Failed to release multisig escrow freeze/);
    assert.equal(freezeReleaseCalled.count, 1, 'releaseEscrowFreeze should be called');
    assert.equal(rollbackCalled.value, true, 'Transaction should be rolled back on failure');
  } finally {
    cleanup();
  }
});

test('PATCH /disputes/:id rolls back transaction on Soroban release failure', async () => {
  const freezeReleaseCalled = { count: 0 };
  const sorobanReleaseCalled = { count: 0 };
  const { app, rollbackCalled, cleanup } = buildAppForPatch({
    escrowContractId: 'CESCROW123',
    arbitratorSignerAdded: true,
    sorobanEnabled: 'true',
    raisedAmount: '500.00',
    freezeReleaseCalled,
    sorobanReleaseCalled,
    sorobanReleaseShouldFail: true,
  });

  try {
    const res = await request(app)
      .patch(`/api/disputes/${DISPUTE_ID}`)
      .send({ status: 'resolved_creator', resolution_note: 'Creator wins' });

    assert.equal(res.status, 500);
    assert.match(res.body.error, /Failed to release Soroban escrow funds/);
    assert.equal(freezeReleaseCalled.count, 1, 'Freeze release should be called first');
    assert.equal(sorobanReleaseCalled.count, 1, 'Soroban release should be attempted');
    assert.equal(rollbackCalled.value, true, 'Transaction should be rolled back on failure');
  } finally {
    cleanup();
  }
});
