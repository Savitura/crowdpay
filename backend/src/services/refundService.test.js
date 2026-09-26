const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function makeMockDb(queryHandler) {
  const client = {
    queryLog: [],
    async query(sql, params) {
      this.queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (queryHandler) return queryHandler(sql, params);
      return { rows: [] };
    },
    release() {},
  };
  return {
    connect: async () => client,
    query: async (sql, params) => client.query(sql, params),
    _client: client,
  };
}

test('refundService success with hash', async () => {
  let stellarCalled = false;
  const dbMock = makeMockDb((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          id: 'contrib-1',
          amount: '100',
          refunded_amount: '0',
          asset: 'USDC',
          sender_public_key: 'GC123',
          campaign_id: 'camp-1',
          user_id: 'user-1',
        }],
      };
    }
    if (sql.includes('INSERT INTO creator_refunds')) {
      return {
        rows: [{ id: 'ref-1', campaign_id: 'camp-1', contribution_id: 'contrib-1', recipient_wallet: 'GC123', amount: 50, asset: 'USDC', status: 'processing' }],
      };
    }
    return { rows: [] };
  });

  const service = proxyquire('./refundService', {
    '../config/database': dbMock,
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './notifications': { createNotification: async () => {} },
    './emailService': { sendEmail: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' } },
    './stellarService': {
      sendCampaignRefund: async () => {
        stellarCalled = true;
        return { hash: 'TXHASH123' };
      },
    },
  });

  const result = await service.processRefund({
    campaignId: 'camp-1',
    contributionId: 'contrib-1',
    amount: '50',
    reason: 'test refund',
    initiatorId: 'admin-1',
  });

  assert.equal(stellarCalled, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.tx_hash, 'TXHASH123');
});

test('refundService missing sender function or missing hash fails and rolls back', async () => {
  const dbMock = makeMockDb((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          id: 'contrib-1',
          amount: '100',
          refunded_amount: '0',
          asset: 'USDC',
          sender_public_key: 'GC123',
          campaign_id: 'camp-1',
          user_id: 'user-1',
        }],
      };
    }
    if (sql.includes('INSERT INTO creator_refunds')) {
      return {
        rows: [{ id: 'ref-1', campaign_id: 'camp-1', contribution_id: 'contrib-1', recipient_wallet: 'GC123', amount: 50, asset: 'USDC', status: 'processing' }],
      };
    }
    return { rows: [] };
  });

  const service = proxyquire('./refundService', {
    '../config/database': dbMock,
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './notifications': { createNotification: async () => {} },
    './emailService': { sendEmail: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' } },
    './stellarService': {},
  });

  await assert.rejects(
    service.processRefund({
      campaignId: 'camp-1',
      contributionId: 'contrib-1',
      amount: 50,
      reason: 'test refund',
      initiatorId: 'admin-1',
    }),
    /No on-chain transaction hash/
  );
});

test('refundService sender throws error', async () => {
  const dbMock = makeMockDb((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          id: 'contrib-1',
          amount: '100',
          refunded_amount: '0',
          asset: 'USDC',
          sender_public_key: 'GC123',
          campaign_id: 'camp-1',
          user_id: 'user-1',
        }],
      };
    }
    if (sql.includes('INSERT INTO creator_refunds')) {
      return {
        rows: [{ id: 'ref-1', campaign_id: 'camp-1', contribution_id: 'contrib-1', recipient_wallet: 'GC123', amount: 50, asset: 'USDC', status: 'processing' }],
      };
    }
    return { rows: [] };
  });

  const service = proxyquire('./refundService', {
    '../config/database': dbMock,
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './notifications': { createNotification: async () => {} },
    './emailService': { sendEmail: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' } },
    './stellarService': {
      sendCampaignRefund: async () => {
        throw new Error('horizon timeout');
      },
    },
  });

  await assert.rejects(
    service.processRefund({
      campaignId: 'camp-1',
      contributionId: 'contrib-1',
      amount: 50,
      reason: 'test refund',
      initiatorId: 'admin-1',
    }),
    /On-chain refund failed/
  );
});

test('refundService pagination and bounds', async () => {
  let lastQuery = null;
  const dbMock = makeMockDb((sql, params) => {
    lastQuery = { sql, params };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '2' }] };
    return { rows: [] };
  });

  const service = proxyquire('./refundService', {
    '../config/database': dbMock,
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './notifications': { createNotification: async () => {} },
    './emailService': { sendEmail: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' } },
    './stellarService': {},
  });

  const res = await service.getCampaignRefunds('camp-1', { limit: 1000, offset: -10 });
  assert.equal(res.limit, 500);
  assert.equal(res.offset, 0);

  const eligible = await service.getEligibleContributions('camp-1', { limit: 10, offset: 5 });
  assert.ok(eligible);
  assert.equal(lastQuery.params[1], 10);
  assert.equal(lastQuery.params[2], 5);
});

test('refundService amount parsing validation', async () => {
  const dbMock = makeMockDb((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          id: 'contrib-1',
          amount: '100',
          refunded_amount: '0',
          asset: 'USDC',
          sender_public_key: 'GC123',
          campaign_id: 'camp-1',
          user_id: 'user-1',
        }],
      };
    }
    return { rows: [] };
  });

  const service = proxyquire('./refundService', {
    '../config/database': dbMock,
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './notifications': { createNotification: async () => {} },
    './emailService': { sendEmail: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: { REFUND_ISSUED: 'refund.issued' } },
    './stellarService': {},
  });

  await assert.rejects(
    service.processRefund({
      campaignId: 'camp-1',
      contributionId: 'contrib-1',
      amount: 'invalid',
      reason: 'test',
      initiatorId: 'admin-1',
    }),
    /valid positive number/
  );

  await assert.rejects(
    service.processRefund({
      campaignId: 'camp-1',
      contributionId: 'contrib-1',
      amount: 150,
      reason: 'test',
      initiatorId: 'admin-1',
    }),
    /remaining refundable amount/
  );
});
