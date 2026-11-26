const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildDisputeService({ queryImpl, connectImpl } = {}) {
  const logs = { info: [], warn: [], error: [] };
  const mockDb = {
    query: queryImpl || (async () => ({ rows: [] })),
    connect: connectImpl || (async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    })),
  };

  const service = proxyquire('./disputeService', {
    '../config/database': mockDb,
    '../config/logger': {
      info: (msg, meta) => logs.info.push({ msg, meta }),
      warn: (msg, meta) => logs.warn.push({ msg, meta }),
      error: (msg, meta) => logs.error.push({ msg, meta }),
      debug: () => {},
    },
  });

  return { service, logs, mockDb };
}

test('createDispute validates reason and non-empty description', async () => {
  const { service } = buildDisputeService();

  await assert.rejects(
    async () => {
      await service.createDispute({ campaignId: 1, userId: 'user-1', reason: 'invalid_reason', description: 'valid desc' });
    },
    { status: 422 }
  );

  await assert.rejects(
    async () => {
      await service.createDispute({ campaignId: 1, userId: 'user-1', reason: 'non_delivery', description: '   ' });
    },
    { status: 422 }
  );
});

test('createDispute rejects non-contributors', async () => {
  const { service, mockDb } = buildDisputeService({
    queryImpl: async sql => {
      if (sql.includes('SELECT id, creator_id')) {
        return { rows: [{ id: 10, creator_id: 'creator-9' }] };
      }
      if (sql.includes('SELECT id FROM contributions')) {
        return { rows: [] }; // Not a contributor
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    async () => {
      await service.createDispute({ campaignId: 10, userId: 'stranger', reason: 'abandoned', description: 'No updates' });
    },
    { status: 403, code: 'NOT_A_CONTRIBUTOR' }
  );
});

test('createDispute inserts dispute and logs event when user is verified contributor', async () => {
  const queries = [];
  const mockClient = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO disputes')) {
        return { rows: [{ id: 77, campaign_id: 10, status: 'open' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const { service } = buildDisputeService({
    queryImpl: async sql => {
      if (sql.includes('SELECT id, creator_id')) {
        return { rows: [{ id: 10, creator_id: 'creator-9' }] };
      }
      if (sql.includes('SELECT id FROM contributions')) {
        return { rows: [{ id: 501 }] };
      }
      return { rows: [] };
    },
    connectImpl: async () => mockClient,
  });

  const dispute = await service.createDispute({
    campaignId: 10,
    userId: 'backer-1',
    reason: 'non_delivery',
    description: 'Creator stopped replying',
  });

  assert.equal(dispute.id, 77);
  assert.ok(queries.some(q => q.sql.includes('INSERT INTO disputes')));
  assert.ok(queries.some(q => q.sql.includes('INSERT INTO dispute_events')));
});

test('listCampaignDisputes returns paginated disputes with total count', async () => {
  const { service } = buildDisputeService({
    queryImpl: async sql => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          {
            id: 88,
            campaign_id: 12,
            reason: 'misrepresentation',
            raised_by_name: 'Backer Bob',
          },
        ],
      };
    },
  });

  const res = await service.listCampaignDisputes(12, { limit: 10, offset: 0 });

  assert.equal(res.total, 1);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].id, 88);
});

test('submitEvidence rejects unauthorized users and accepts valid party evidence', async () => {
  const queries = [];
  const { service } = buildDisputeService({
    queryImpl: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT d.*, c.creator_id')) {
        return { rows: [{ id: 99, raised_by: 'disputer-1', creator_id: 'creator-2' }] };
      }
      if (sql.includes('INSERT INTO dispute_evidence')) {
        return { rows: [{ id: 301, dispute_id: 99, role: 'contributor', text: 'Tracking screenshot' }] };
      }
      return { rows: [] };
    },
  });

  // Unauthorized user
  await assert.rejects(
    async () => {
      await service.submitEvidence({ disputeId: 99, userId: 'intruder', text: 'spam' });
    },
    { status: 403 }
  );

  // Authorized user
  const evidence = await service.submitEvidence({
    disputeId: 99,
    userId: 'disputer-1',
    text: 'Tracking screenshot',
    attachmentUrls: ['https://example.com/receipt.png'],
  });

  assert.equal(evidence.id, 301);
  assert.equal(evidence.role, 'contributor');
});

test('updateDisputeStatus updates status and logs resolution note', async () => {
  const queries = [];
  const { service } = buildDisputeService({
    queryImpl: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT * FROM disputes')) {
        return { rows: [{ id: 105, status: 'open' }] };
      }
      if (sql.includes('UPDATE disputes')) {
        return { rows: [{ id: 105, status: 'resolved_contributor', resolution_note: 'Refund granted' }] };
      }
      return { rows: [] };
    },
  });

  const updated = await service.updateDisputeStatus({
    disputeId: 105,
    actorId: 'admin-1',
    status: 'resolved_contributor',
    resolutionNote: 'Refund granted',
  });

  assert.equal(updated.status, 'resolved_contributor');
  assert.equal(updated.resolution_note, 'Refund granted');
});
