const assert = require('node:assert/strict');
const test = require('node:test');
const proxyquire = require('proxyquire').noCallThru();

function makeService({ contribution = {}, reserved = true, reviewer = true, request = {} } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT c.id AS campaign_id'))
        return {
          rows: [
            {
              campaign_id: 'campaign-1',
              creator_id: 'creator-1',
              campaign_status: 'failed',
              deadline: '2026-09-10T00:00:00.000Z',
              contribution_id: 'contribution-1',
              contribution_amount: '100',
              refunded_amount: '0',
              refund_reserved_amount: '0',
              contribution_status: 'confirmed',
              sender_public_key: 'GCONTRIBUTOR',
              ...contribution,
            },
          ],
        };
      if (sql.includes('UPDATE contributions') && sql.includes('>= $1'))
        return { rows: reserved ? [{ refund_reserved_amount: '50' }] : [] };
      if (sql.includes('INSERT INTO refund_requests'))
        return { rows: [{ id: 'request-1', status: 'pending', ...request }] };
      if (sql.includes('INSERT INTO refund_request_events')) return { rows: [] };
      if (sql.includes('SELECT rr.*, c.creator_id'))
        return {
          rows: reviewer
            ? [
                {
                  id: 'request-1',
                  status: 'pending',
                  campaign_id: 'campaign-1',
                  contribution_id: 'contribution-1',
                  contributor_id: 'contributor-1',
                  creator_id: 'creator-1',
                  deadline: '2026-09-10T00:00:00.000Z',
                  amount: '50',
                },
              ]
            : [],
        };
      if (sql.includes('campaign_members')) return { rows: reviewer ? [{ 1: 1 }] : [] };
      if (sql.includes('UPDATE refund_requests'))
        return { rows: [{ id: 'request-1', status: params[0] || 'approved' }] };
      return { rows: [] };
    },
    release() {},
  };
  const db = {
    connect: async () => client,
    query: async (sql, params) => client.query(sql, params),
    calls,
  };
  return proxyquire('./refundRequestService', {
    '../config/database': db,
    './notifications': { createNotification: async () => {} },
    './auditService': { logAuditEvent: async () => {} },
    './refundService': { processRefund: async () => ({ tx_hash: 'tx-1' }) },
  });
}

test('withinRequestWindow accepts the deadline boundary and rejects after the configured window', () => {
  const service = makeService();
  assert.equal(
    service.withinRequestWindow('2026-09-10T00:00:00.000Z', new Date('2026-09-10T00:00:00.000Z')),
    true
  );
  assert.equal(
    service.withinRequestWindow('2026-09-10T00:00:00.000Z', new Date('2026-10-11T00:00:00.000Z')),
    false
  );
});

test('createRequest reserves refundable balance and records a pending request', async () => {
  const service = makeService();
  const result = await service.createRequest({
    campaignId: 'campaign-1',
    contributionId: 'contribution-1',
    contributorId: 'contributor-1',
    amount: 50,
    reason: 'Campaign failed',
    now: new Date('2026-09-12'),
  });
  assert.equal(result.status, 'pending');
});

test('createRequest rejects non-positive amounts before opening a transaction', async () => {
  const service = makeService();
  await assert.rejects(() => service.createRequest({ amount: 0, reason: 'x' }), /positive/);
});

test('createRequest rejects an amount that cannot be atomically reserved', async () => {
  const service = makeService({ reserved: false });
  await assert.rejects(
    () =>
      service.createRequest({
        campaignId: 'campaign-1',
        contributionId: 'contribution-1',
        contributorId: 'contributor-1',
        amount: 101,
        reason: 'Too much',
        now: new Date('2026-09-12'),
      }),
    /remaining refundable balance/
  );
});

test('createRequest rejects an expired request window', async () => {
  const service = makeService();
  await assert.rejects(
    () =>
      service.createRequest({
        campaignId: 'campaign-1',
        contributionId: 'contribution-1',
        contributorId: 'contributor-1',
        amount: 10,
        reason: 'Late',
        now: new Date('2026-10-11'),
      }),
    /window is closed/
  );
});

test('reviewRequest requires a rejection reason', async () => {
  const service = makeService();
  await assert.rejects(
    () => service.reviewRequest('request-1', { reviewerId: 'creator-1', approve: false }),
    /reason is required/
  );
});

test('reviewRequest rejects an unauthorized reviewer', async () => {
  const service = makeService({ reviewer: false });
  await assert.rejects(
    () => service.reviewRequest('request-1', { reviewerId: 'stranger', approve: true }),
    /not found|authorized/i
  );
});
