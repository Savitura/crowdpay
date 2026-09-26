const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function makeMockDb(queryHandler) {
  const client = {
    queryLog: [],
    async query(sql, params) {
      this.queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (queryHandler) return queryHandler(sql, params, this);
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

test('refundService pagination bounds and filtering', async (t) => {
  await t.test('getEligibleContributions clamps limit and offset', async () => {
    let capturedParams;
    const dbMock = makeMockDb(async (sql, params) => {
      if (sql.includes('SELECT')) {
        capturedParams = params;
        return { rows: [{ id: 'contrib-1' }] };
      }
      return { rows: [] };
    });

    const service = proxyquire('./refundService', {
      '../config/database': dbMock,
      '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
      './notifications': { createNotification: async () => {} },
      './emailService': { sendEmail: async () => {} },
      './auditService': { logAuditEvent: async () => {} },
      './webhookDispatcher': { emitWebhookEventForUser: async () => {} },
    });

    await service.getEligibleContributions('camp-1', { limit: 9999, offset: -5 });
    assert.equal(capturedParams[1], 500, 'Limit should be clamped to 500 max');
    assert.equal(capturedParams[2], 0, 'Offset should be clamped to 0 min');
  });

  await t.test('getCampaignRefunds clamps limit and offset', async () => {
    let capturedParams;
    const dbMock = makeMockDb(async (sql, params) => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: '1' }] };
      }
      if (sql.includes('SELECT')) {
        capturedParams = params;
        return { rows: [{ id: 'ref-1' }] };
      }
      return { rows: [] };
    });

    const service = proxyquire('./refundService', {
      '../config/database': dbMock,
      '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
      './notifications': { createNotification: async () => {} },
      './emailService': { sendEmail: async () => {} },
      './auditService': { logAuditEvent: async () => {} },
      './webhookDispatcher': { emitWebhookEventForUser: async () => {} },
    });

    const res = await service.getCampaignRefunds('camp-1', { limit: -10, offset: -20 });
    assert.equal(res.limit, 1, 'Limit should be clamped to min 1');
    assert.equal(res.offset, 0, 'Offset should be clamped to min 0');
  });
});

test('processRefund on-chain execution branches', async (t) => {
  await t.test('success with a transaction hash', async () => {
    const dbMock = makeMockDb(async (sql, params, client) => {
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [{
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
        };
      }
      if (sql.includes('INSERT INTO creator_refunds')) {
        return {
          rows: [{
            id: 'refund-1',
            recipient_wallet: 'GWALLET',
            asset: 'native',
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
      './webhookDispatcher': { emitWebhookEventForUser: async () => {} },
      './stellarService': {
        sendCampaignRefund: async () => ({ hash: 'TXABC123' }),
      },
    });

    const result = await service.processRefund({
      campaignId: 'camp-1',
      contributionId: 'contrib-1',
      amount: '50',
      initiatorId: 'admin-1',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.tx_hash, 'TXABC123');
  });

  await t.test('missing sender function fails and rolls back', async () => {
    const dbMock = makeMockDb(async (sql) => {
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 'contrib-1',
            amount: '100',
            refunded_amount: '0',
            asset: 'native',
            sender_public_key: 'GWALLET',
            campaign_id: 'camp-1',
            user_id: 'user-1',
          }],
        };
      }
      if (sql.includes('INSERT INTO creator_refunds')) {
        return {
          rows: [{
            id: 'refund-1',
            recipient_wallet: 'GWALLET',
            asset: 'native',
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
      './webhookDispatcher': { emitWebhookEventForUser: async () => {} },
      './stellarService': {}, // sendCampaignRefund is absent
    });

    await assert.rejects(
      async () => {
        await service.processRefund({
          campaignId: 'camp-1',
          contributionId: 'contrib-1',
          amount: '50',
          initiatorId: 'admin-1',
        });
      },
      /On-chain refund transfer failed or sender function unavailable/
    );
  });

  await t.test('sender throws error fails and rolls back', async () => {
    const dbMock = makeMockDb(async (sql) => {
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 'contrib-1',
            amount: '100',
            refunded_amount: '0',
            asset: 'native',
            sender_public_key: 'GWALLET',
            campaign_id: 'camp-1',
            user_id: 'user-1',
          }],
        };
      }
      if (sql.includes('INSERT INTO creator_refunds')) {
        return {
          rows: [{
            id: 'refund-1',
            recipient_wallet: 'GWALLET',
            asset: 'native',
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
      './webhookDispatcher': { emitWebhookEventForUser: async () => {} },
      './stellarService': {
        sendCampaignRefund: async () => {
          throw new Error('Network timeout');
        },
      },
    });

    await assert.rejects(
      async () => {
        await service.processRefund({
          campaignId: 'camp-1',
          contributionId: 'contrib-1',
          amount: '50',
          initiatorId: 'admin-1',
        });
      },
      /On-chain refund failed - state rolled back/
    );
  });
});
