const assert = require('node:assert');
const test = require('node:test');
const proxyquire = require('proxyquire').noCallThru();

const mockClient = {
  queryLog: [],
  rows: {
    contrib: [{
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
    }],
  },
  async query(sql, params) {
    this.queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('FOR UPDATE')) return { rows: this.rows.contrib };
    if (sql.includes('INSERT INTO creator_refunds')) {
      return {
        rows: [{
          id: 'refund-1',
          campaign_id: params[0],
          contribution_id: params[1],
          recipient_wallet: params[2],
          amount: params[3],
          asset: params[4],
          reason: params[5],
          status: 'processing',
          is_force_refund: params[6],
          admin_note: params[7],
          created_by: params[8],
        }],
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

function makeService(dbOverride, stellarShouldFail) {
  const mockDb = dbOverride || makeMockDb();
  return {
    svc: proxyquire('../services/refundService', {
      '../config/database': mockDb,
      '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
      './notifications': { createNotification: async () => {} },
      './emailService': { sendEmail: async () => {} },
      './auditService': { logAuditEvent: async () => {} },
      './webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' } },
      './stellarService': {
        sendCampaignRefund: stellarShouldFail
          ? async () => { throw new Error('on-chain failure'); }
          : async () => ({ hash: 'TX123' }),
      },
    }),
    db: mockDb,
  };
}

test('getEligibleContributions returns contributions with remaining amount', async () => {
  const mockDb = {
    connect: async () => mockClient,
    query: async (sql) => {
      if (sql.includes('FROM contributions')) {
        return { rows: [{ id: 'c1', amount: '100', refunded_amount: '30', remaining_amount: '70', asset: 'native' }] };
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
    () => svc.processRefund({ campaignId: 'camp-1', contributionId: 'contrib-1', amount: 200, reason: 'x', initiatorId: 'creator-1' }),
    (err) => { assert.equal(err.status, 422); return true; }
  );
});

test('processRefund rolls back and throws on on-chain failure', async () => {
  const { svc } = makeService(null, true);
  await assert.rejects(
    () => svc.processRefund({ campaignId: 'camp-1', contributionId: 'contrib-1', amount: 50, reason: 'x', initiatorId: 'creator-1' }),
    (err) => { assert.equal(err.status, 502); return true; }
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
    () => svc.processRefund({ campaignId: 'camp-1', contributionId: 'missing', amount: 10, reason: 'x', initiatorId: 'u' }),
    (err) => { assert.equal(err.status, 404); return true; }
  );
});
