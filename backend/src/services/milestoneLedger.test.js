const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toReleaseAmount,
  logMilestoneEvent,
  logWithdrawalEvent,
  getMilestoneVoteTally,
  votesBlockRelease,
  setCampaignStatusFromMilestoneProgress,
} = require('./milestoneLedger');

test('toReleaseAmount computes release amount with 7 decimal precision', () => {
  assert.equal(toReleaseAmount(1000, 25), '250.0000000');
  assert.equal(toReleaseAmount(100, 33.3333333), '33.3333333');
  assert.equal(toReleaseAmount(0, 50), '0.0000000');
  assert.equal(toReleaseAmount(500.5, 10), '50.0500000');
});

test('logMilestoneEvent executes parameterized insert with sanitized jsonb metadata', async () => {
  let executedQuery = null;
  let executedParams = null;
  const mockQ = {
    query: async (sql, params) => {
      executedQuery = sql;
      executedParams = params;
      return { rows: [] };
    },
  };

  await logMilestoneEvent(mockQ, {
    milestoneId: 10,
    actorUserId: 'user-123',
    action: 'submitted',
    note: 'Evidence attached',
    metadata: { hash: 'abc1234' },
  });

  assert.match(executedQuery, /INSERT INTO milestone_events/);
  assert.deepEqual(executedParams, [
    10,
    'user-123',
    'submitted',
    'Evidence attached',
    '{"hash":"abc1234"}',
  ]);

  // Null defaults check
  await logMilestoneEvent(mockQ, {
    milestoneId: 11,
    action: 'approved',
  });
  assert.deepEqual(executedParams, [11, null, 'approved', null, '{}']);
});

test('logWithdrawalEvent executes parameterized insert with sanitized metadata', async () => {
  let executedQuery = null;
  let executedParams = null;
  const mockQ = {
    query: async (sql, params) => {
      executedQuery = sql;
      executedParams = params;
      return { rows: [] };
    },
  };

  await logWithdrawalEvent(mockQ, {
    withdrawalRequestId: 42,
    actorUserId: 'admin-1',
    action: 'approved',
    note: 'Verified criteria',
    metadata: { txHash: 'stellar-tx-hash' },
  });

  assert.match(executedQuery, /INSERT INTO withdrawal_approval_events/);
  assert.deepEqual(executedParams, [
    42,
    'admin-1',
    'approved',
    'Verified criteria',
    '{"txHash":"stellar-tx-hash"}',
  ]);

  // Null metadata check
  await logWithdrawalEvent(mockQ, {
    withdrawalRequestId: 43,
    action: 'rejected',
  });
  assert.deepEqual(executedParams, [43, null, 'rejected', null, null]);
});

test('getMilestoneVoteTally computes totals, approval ratio, and fetches user vote if requested', async () => {
  const queries = [];
  const mockQ = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT vote, note')) {
        return {
          rows: [
            {
              vote: 'approve',
              note: 'Looks good',
              created_at: '2026-01-01',
              updated_at: '2026-01-01',
            },
          ],
        };
      }
      return {
        rows: [
          {
            approve_count: 8,
            reject_count: 2,
            total_votes: 10,
          },
        ],
      };
    },
  };

  const tally = await getMilestoneVoteTally(mockQ, 101, 'user-55');

  assert.equal(tally.approve_count, 8);
  assert.equal(tally.reject_count, 2);
  assert.equal(tally.total_votes, 10);
  assert.equal(tally.approval_ratio, 0.8);
  assert.deepEqual(tally.user_vote, {
    vote: 'approve',
    note: 'Looks good',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  });
  assert.equal(queries.length, 2);
});

test('getMilestoneVoteTally handles zero votes cleanly without division by zero', async () => {
  const mockQ = {
    query: async () => ({
      rows: [
        {
          approve_count: 0,
          reject_count: 0,
          total_votes: 0,
        },
      ],
    }),
  };

  const tally = await getMilestoneVoteTally(mockQ, 202);

  assert.equal(tally.approve_count, 0);
  assert.equal(tally.reject_count, 0);
  assert.equal(tally.total_votes, 0);
  assert.equal(tally.approval_ratio, null);
  assert.equal(tally.user_vote, null);
});

test('votesBlockRelease detects whether approvals outnumber rejections', () => {
  // No votes -> does not block
  assert.equal(votesBlockRelease({ total_votes: 0, approve_count: 0, reject_count: 0 }), false);

  // Approvals strictly outnumber rejections -> does not block
  assert.equal(votesBlockRelease({ total_votes: 5, approve_count: 3, reject_count: 2 }), false);

  // Tie -> blocks release
  assert.equal(votesBlockRelease({ total_votes: 4, approve_count: 2, reject_count: 2 }), true);

  // Rejections outnumber approvals -> blocks release
  assert.equal(votesBlockRelease({ total_votes: 5, approve_count: 1, reject_count: 4 }), true);
});

test('setCampaignStatusFromMilestoneProgress updates campaign to completed when all milestones released', async () => {
  const queries = [];
  const mockQ = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT')) {
        return { rows: [{ total: 3, released_count: 3 }] };
      }
      return { rows: [{ id: 50, status: 'completed' }] };
    },
  };

  const res = await setCampaignStatusFromMilestoneProgress(mockQ, 50);

  assert.deepEqual(res, { id: 50, status: 'completed' });
  assert.equal(queries[1].params[0], 'completed');
  assert.equal(queries[1].params[1], 50);
});

test('setCampaignStatusFromMilestoneProgress updates to in_progress when partial milestones released', async () => {
  const queries = [];
  const mockQ = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT')) {
        return { rows: [{ total: 4, released_count: 2 }] };
      }
      return { rows: [{ id: 51, status: 'in_progress' }] };
    },
  };

  const res = await setCampaignStatusFromMilestoneProgress(mockQ, 51);

  assert.deepEqual(res, { id: 51, status: 'in_progress' });
  assert.equal(queries[1].params[0], 'in_progress');
});

test('setCampaignStatusFromMilestoneProgress returns null if no milestones exist or released count is 0', async () => {
  const mockQ1 = {
    query: async () => ({ rows: [{ total: 0, released_count: 0 }] }),
  };
  const res1 = await setCampaignStatusFromMilestoneProgress(mockQ1, 52);
  assert.equal(res1, null);

  const mockQ2 = {
    query: async () => ({ rows: [{ total: 3, released_count: 0 }] }),
  };
  const res2 = await setCampaignStatusFromMilestoneProgress(mockQ2, 53);
  assert.equal(res2, null);
});
