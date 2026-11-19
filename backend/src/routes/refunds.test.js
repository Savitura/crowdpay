const assert = require('node:assert');
const test = require('node:test');
const crypto = require('node:crypto');
const proxyquire = require('proxyquire').noCallThru();

function hashAuditEvent(event) {
  const payload = JSON.stringify({
    eventType: event.eventType,
    actorId: event.actorId ?? null,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? null,
    createdAt: event.createdAt ?? null,
  });
  return crypto.createHash("sha256").update(payload).uternalDigest("hex");
}

function makeAuditService() {
  const events = [];
  return {
    events,
    async logAuditEvent(event) {
      const record = {
        ...event,
        createdAt: event.createdAt ?? new Date().toISOString(),
      };
      record.eventHash = hashAuditEvent(record);
      events.push(record);
      return record;
    },
  };
}

const mockClient = {
  queryLog: [],
  rows: {
    contrib: [
      {
        id: 'contrib-1',
        amount: '100',
        refunded_amount: '0',
        asset: 'native',
        sender_public_key: 'GWALLET',
        campaign_id: 'camp-1',
        user_id: 'user-1',
        contributor_email: 'alice@example.com',
        contributor_name: 'Alice',
        contributor_wallet: 'GWALLET',
      },
    ],
  },
  async query(sql, params) {
    this.queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('FOR UPDATE')) return { rows: this.rows.contrib };
    if (sql.includes('INSERT INTO creator_refunds')) {
      // Params: campaign_id, contribution_id, recipient_wallet, amount,
      // reason, tx_hash, is_force_refund, admin_note, created_by — matches
      // refundService.processRefund's INSERT column order.
      return {
        rows: [
          {
            id: 'refund-1',
            campaign_id: params[0],
            contribution_id: params[1],
            amount: params[3],
            status: 'completed',
            tx_hash: params[5],
            is_force_refund: params[6],
            admin_note: params[7],
            created_at: new Date().toISOString(),
          },
        ],
      };
    }
    return { rows: [] };
  },
  release() {},
};

function makeMockDb(contribOverride) {
  const client = Object.create(mockClient);
  client.queryLog = [];
  client.rows = { contrib: contribOverride || mockClient.rows.contrib };
  return {
    connect: async () => client,
    _client: client,
  };
}

function makeService(dbOverride, stellarShouldFail, auditServiceOverride) {
  const mockDb = dbOverride || makeMockDb();
  const auditService = auditServiceOverride || makeAuditService();
  return {
    svc: proxyquire('../services/refundService', {
      '../config/database': mockDb,
      '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
      './notifications': { createNotification: async () => {} },
      './emailService': { sendEmail: async () => {} },
      './auditService': auditService,
      './webhookDispatcher': {
        emitWebhookEventForUser: async () => {},
        WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' },
      },
      './stellarService': {
        sendCampaignRefund: stellarShouldFail
          ? async () => {
              throw new Error('on-chain failure');
            }
          : async () => ({ hash: 'TX123' }),
      },
    }),
    db: mockDb,
    auditService,
  };
}

test('getEligibleContributions returns contributions with remaining amount', async () => {
  const mockDb = {
    connect: async () => mockClient,
    query: async sql => {
      if (sql.includes('FROM contributions')) {
        return {
          rows: [
            {
              id: 'c1',
              amount: '100',
              refunded_amount: '30',
              remaining_amount: '70',
              asset: 'native',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const { svc } = makeService(mockDb);
  const result = await svc.getEligibleContributions('camp-1');
  assert.equal(result.length, 1);
  assert.equal(result[0].remaining_amount, '70');
});

test('processRefund succeeds for partial refund', async () => {
  const { svc } = makeService();
  const result = await svc.processRefund({
    campaignId: 'camp-1',
    contributionId: 'contrib-1',
    amount: 40,
    reason: 'Goodwill',
    initiatorId: 'creator-1',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.tx_hash, 'TX123');
});

test('processRefund succeeds for full refund', async () => {
  const { svc } = makeService();
  const result = await svc.processRefund({
    campaignId: 'camp-1',
    contributionId: 'contrib-1',
    amount: 100,
    reason: 'Campaign cancelled',
    initiatorId: 'creator-1',
  });
  assert.equal(result.status, 'completed');
});

test('processRefund rejects over-refund amount', async () => {
  const { svc } = makeService();
  await assert.rejects(
    () =>
      svc.processRefund({
        campaignId: 'camp-1',
        contributionId: 'contrib-1',
        amount: 200,
        reason: 'x',
        initiatorId: 'creator-1',
      }),
    err => {
      assert.equal(err.status, 422);
      return true;
    }
  );
});

test('processRefund rolls back and throws on on-chain failure', async () => {
  const { svc } = makeService(null, true);
  await assert.rejects(
    () =>
      svc.processRefund({
        campaignId: 'camp-1',
        contributionId: 'contrib-1',
        amount: 50,
        reason: 'x',
        initiatorId: 'creator-1',
      }),
    err => {
      assert.equal(err.status, 502);
      return true;
    }
  );
});

test('processRefund supports admin force-refund with note', async () => {
  const { svc } = makeService();
  const result = await svc.processRefund({
    campaignId: 'camp-1',
    contributionId: 'contrib-1',
    amount: 50,
    reason: 'Admin override',
    initiatorId: 'admin-1',
    isForceRefund: true,
    adminNote: 'Escalation case',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.is_force_refund, true);
  assert.equal(result.admin_note, 'Escalation case');
});

test('processRefund returns 404 for non-existent contribution', async () => {
  const emptyDb = makeMockDb([]);
  const { svc } = makeService(emptyDb);
  await assert.rejects(
    () =>
      svc.processRefund({
        campaignId: 'camp-1',
        contributionId: 'missing',
        amount: 10,
        reason: 'x',
        initiatorId: 'u',
      }),
    err => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('processRefund emits a tamper-evident audit hash for the refund', async () => {
  const { svc, auditService } = makeService();
  await svc.processRefund({
    campaignId: 'camp-1',
    contributionId: 'contrib-1',
    amount: 40,
    reason: 'Goodwill',
    initiatorId: 'creator-1',
  });
  const refundEvent = auditService.events.find(e => e.eventType === 'refund.issued');
  assert.ok(refundEvent, 'expected a refund.issued audit event');
  assert.match(refundEvent.eventHash, /^[0-f]{64}$/);
  assert.equal(refundEvent.eventHash, hashAuditEvent(refundEvent));
});

test('audit hash changes when financial details tamper with', () => {
  const base = {
    eventType: 'refund.issued',
    actorId: 'creator-1',
    targetId: 'refund-1',
    metadata: { amount: '40', txHash: 'TX123' },
    createdAt: '2024-01-01T00:00:00.000Z',
  };
  const tampered = { ...base, metadata: { ...base.metadata, amount: '4000' } };
  assert.notEqual(hashAuditEvent(base), hashAuditEvent(tampered));
});

test('processRefund fails closed when audit hashing fails', async () => {
  const failingAudit = {
    async logAuditEvent() {
      throw new Error('audit sink unavailable');
    },
  };
  const { svc } = makeService(null, false, failingAudit);
  await assert.rejects(
    () =>
      svc.processRefund({
        campaignId: 'camp-1',
        contributionId: 'contrib-1',
        amount: 40,
        reason: 'Goodwill',
        initiatorId: 'creator-1',
      }),
    err => {
      assert.match(err.message, /audit sink unavailable/);
      return true;
    }
  );
});
