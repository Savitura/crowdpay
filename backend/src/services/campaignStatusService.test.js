const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const RETURNING_MARKER = 'RETURNING id, title, creator_id, target_amount, raised_amount, deadline, status, escrow_contract_id';

function makeConnectMock(handlers) {
  const client = {
    query: async (text, params) => {
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: handlers.lockAcquired !== false }] };
      }
      if (text.includes('pg_advisory_unlock')) {
        handlers.unlocked = true;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (text.includes('UPDATE campaigns')) {
        handlers.updateCalls = (handlers.updateCalls || 0) + 1;
        handlers.lastUpdateSql = text;
        return handlers.updateResult || { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {
      handlers.released = true;
    },
  };
  return {
    connect: async () => client,
    handlers,
  };
}

test('refreshActiveCampaignStatuses uses one atomic update and triggers actions', async () => {
  const queries = [];
  const triggered = [];
  const loggedTransitions = [];
  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': {
      connect: async () => ({
        query: async (text) => {
          queries.push(text);
          if (text.includes('pg_try_advisory_lock')) {
            return { rows: [{ acquired: true }] };
          }
          if (text.includes('pg_advisory_unlock')) {
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          if (text.includes('UPDATE campaigns')) {
            return {
              rows: [
                {
                  id: 'funded-1',
                  status: 'funded',
                  creator_id: 'user-abc',
                  raised_amount: '500',
                  target_amount: '500',
                  backer_count: '10',
                  deadline: '2026-06-30',
                },
                {
                  id: 'failed-1',
                  status: 'failed',
                  creator_id: 'user-xyz',
                  raised_amount: '50',
                  target_amount: '500',
                  backer_count: '2',
                  deadline: '2026-06-01',
                },
              ],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    },
    '../config/logger': {
      info: (message, meta) => {
        if (message === 'Campaign status transition') loggedTransitions.push(meta);
      },
      error: () => {},
    },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async (campaign) => {
        triggered.push(campaign);
      },
    },
  });

  const result = await refreshActiveCampaignStatuses();
  assert.equal(result.funded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.skipped, false);
  assert.equal(triggered.length, 2);
  assert.equal(queries.filter((q) => q.includes('UPDATE campaigns')).length, 1);
  assert.ok(queries.some((q) => q.includes('pg_try_advisory_lock')));
  assert.ok(queries.some((q) => q.includes('pg_advisory_unlock')));

  // Verify structured transition logs were emitted for each campaign
  assert.equal(loggedTransitions.length, 2);
  const fundedLog = loggedTransitions.find((t) => t.campaignId === 'funded-1');
  assert.ok(fundedLog, 'expected a transition log for funded-1');
  assert.equal(fundedLog.creatorId, 'user-abc');
  assert.equal(fundedLog.oldStatus, 'active');
  assert.equal(fundedLog.newStatus, 'funded');
  assert.equal(fundedLog.raisedAmount, 500);
  assert.equal(fundedLog.goalAmount, 500);
  assert.equal(fundedLog.backerCount, 10);
  assert.equal(fundedLog.deadline, '2026-06-30');

  const failedLog = loggedTransitions.find((t) => t.campaignId === 'failed-1');
  assert.ok(failedLog, 'expected a transition log for failed-1');
  assert.equal(failedLog.creatorId, 'user-xyz');
  assert.equal(failedLog.newStatus, 'failed');
  assert.equal(failedLog.backerCount, 2);
});

test('refreshActiveCampaignStatuses skips when advisory lock is held', async () => {
  const handlers = { lockAcquired: false };
  const dbMock = makeConnectMock(handlers);
  const triggered = [];

  const { refreshActiveCampaignStatuses } = proxyquire('./campaignStatusService', {
    '../config/database': dbMock,
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async (campaign) => {
        triggered.push(campaign);
      },
    },
  });

  const result = await refreshActiveCampaignStatuses();
  assert.deepEqual(result, { funded: [], failed: [], skipped: true });
  assert.equal(triggered.length, 0);
  assert.equal(handlers.updateCalls || 0, 0);
  assert.equal(handlers.unlocked, undefined);
  assert.equal(handlers.released, true);
});

test('refreshCampaignStatus uses one atomic update and triggers actions once', async () => {
  const triggered = [];
  const loggedTransitions = [];
  let updateCount = 0;
  const { refreshCampaignStatus } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text, params) => {
        assert.equal(params[0], 'camp-uuid');
        if (text.includes('UPDATE campaigns')) {
          updateCount += 1;
          assert.ok(text.includes('CASE'));
          assert.ok(text.includes(RETURNING_MARKER));
          return {
            rows: [{
              id: 'camp-uuid',
              status: 'funded',
              creator_id: 'creator-1',
              raised_amount: '1000',
              target_amount: '1000',
              backer_count: '25',
              deadline: '2026-07-01',
            }],
          };
        }
        return { rows: [] };
      },
    },
    '../config/logger': {
      info: (message, meta) => {
        if (message === 'Campaign status transition') loggedTransitions.push(meta);
      },
      error: () => {},
    },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async (campaign) => {
        triggered.push(campaign);
      },
    },
  });

  const result = await refreshCampaignStatus('camp-uuid');
  assert.equal(result.funded?.status, 'funded');
  assert.equal(result.failed, null);
  assert.equal(triggered.length, 1);
  assert.equal(updateCount, 1);

  // Verify the structured transition log
  assert.equal(loggedTransitions.length, 1);
  const log = loggedTransitions[0];
  assert.equal(log.campaignId, 'camp-uuid');
  assert.equal(log.creatorId, 'creator-1');
  assert.equal(log.oldStatus, 'active');
  assert.equal(log.newStatus, 'funded');
  assert.equal(log.raisedAmount, 1000);
  assert.equal(log.goalAmount, 1000);
  assert.equal(log.backerCount, 25);
  assert.equal(log.deadline, '2026-07-01');
});

test('refreshCampaignStatus prefers funded over failed when both conditions apply', async () => {
  const { refreshCampaignStatus } = proxyquire('./campaignStatusService', {
    '../config/database': {
      query: async (text) => {
        if (text.includes('UPDATE campaigns')) {
          assert.match(text, /WHEN raised_amount >= target_amount THEN 'funded'/);
          assert.match(
            text,
            /WHEN deadline IS NOT NULL[\s\S]*THEN 'failed'/
          );
          return {
            rows: [{
              id: 'camp-uuid',
              status: 'funded',
              raised_amount: '100',
              target_amount: '100',
            }],
          };
        }
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {}, error: () => {} },
    './campaignStatusActions': {
      triggerCampaignStatusActions: async () => {},
    },
  });

  const result = await refreshCampaignStatus('camp-uuid');
  assert.equal(result.funded?.status, 'funded');
  assert.equal(result.failed, null);
});