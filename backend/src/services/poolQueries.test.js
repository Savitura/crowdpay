const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildReadService(queryImpl) {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return queryImpl(sql, params);
    },
    connect: async () => ({
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return queryImpl(sql, params);
      },
      release() {},
    }),
  };
  return {
    service: proxyquire('./poolQueries', {
      '../config/database': db,
      './contributionService': { submitCustodialContribution: async () => ({ txHash: 'unused' }) },
    }),
    calls,
  };
}

// ---------------------------------------------------------------------------
// join(): a mock DB with a real mutex around the pool row, so concurrent
// `join` calls actually serialize the way `SELECT ... FOR UPDATE` would
// against a real Postgres row lock — this exercises the real race-prevention
// logic in poolQueries.join(), not just a hand-wave.
// ---------------------------------------------------------------------------
function buildJoinService({ pool, existingMembers = [] }) {
  const state = { pool: { ...pool }, members: [...existingMembers] };
  let lockChain = Promise.resolve();

  function makeClient() {
    let release;
    return {
      query: async (text, params) => {
        if (text === 'BEGIN') return { rows: [] };
        if (text === 'COMMIT' || text === 'ROLLBACK') {
          if (release) release();
          return { rows: [] };
        }
        if (
          /SELECT \* FROM contribution_pools WHERE id = \$1 AND status = 'open' FOR UPDATE/.test(
            text
          )
        ) {
          const prev = lockChain;
          let thisRelease;
          lockChain = new Promise(resolve => {
            thisRelease = resolve;
          });
          release = thisRelease;
          await prev;
          if (params[0] !== state.pool.id || state.pool.status !== 'open') return { rows: [] };
          return { rows: [{ ...state.pool }] };
        }
        if (/SELECT COALESCE\(SUM\(share_amount\)/.test(text)) {
          const total = state.members
            .filter(m => ['pending', 'confirmed'].includes(m.status))
            .reduce((sum, m) => sum + parseFloat(m.share_amount), 0);
          return { rows: [{ total: String(total) }] };
        }
        if (/INSERT INTO pool_members/.test(text)) {
          const [poolId, userId, shareAmount, displayName] = params;
          if (state.members.some(m => m.user_id === userId)) return { rows: [] };
          const row = {
            id: `member-${state.members.length + 1}`,
            pool_id: poolId,
            user_id: userId,
            share_amount: shareAmount,
            display_name: displayName,
            status: 'confirmed',
          };
          state.members.push(row);
          return { rows: [row] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
  }

  const service = proxyquire('./poolQueries', {
    '../config/database': {
      connect: async () => makeClient(),
      query: async () => ({ rows: [] }),
    },
    './contributionService': { submitCustodialContribution: async () => ({ txHash: 'unused' }) },
  });

  return { service, state };
}

test('join inserts a confirmed member and rejects a second join from the same user', async () => {
  const { service, state } = buildJoinService({
    pool: { id: 'pool-1', target_amount: '100', status: 'open' },
  });

  const member = await service.join({
    pool_id: 'pool-1',
    user_id: 'user-A',
    share_amount: 40,
    display_name: 'A',
  });
  assert.equal(member.status, 'confirmed');
  assert.equal(state.members.length, 1);

  await assert.rejects(
    () =>
      service.join({ pool_id: 'pool-1', user_id: 'user-A', share_amount: 10, display_name: 'A' }),
    /Already a member/
  );
});

test('join rejects a share that would exceed the remaining pool target', async () => {
  const { service } = buildJoinService({
    pool: { id: 'pool-1', target_amount: '100', status: 'open' },
    existingMembers: [{ user_id: 'user-A', share_amount: '80', status: 'confirmed' }],
  });

  await assert.rejects(
    () =>
      service.join({ pool_id: 'pool-1', user_id: 'user-B', share_amount: 30, display_name: 'B' }),
    /exceeds remaining pool target/
  );
});

test('join serializes two concurrent requests so the pool target cannot be jointly overshot', async () => {
  const { service, state } = buildJoinService({
    pool: { id: 'pool-1', target_amount: '100', status: 'open' },
  });

  const results = await Promise.allSettled([
    service.join({ pool_id: 'pool-1', user_id: 'user-A', share_amount: 60, display_name: 'A' }),
    service.join({ pool_id: 'pool-1', user_id: 'user-B', share_amount: 60, display_name: 'B' }),
  ]);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one of the two racing joins should succeed');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /exceeds remaining pool target/);
  assert.equal(state.members.length, 1);
});

test('listByCampaign and listByUser pass their filters to the expected queries', async () => {
  const { service, calls } = buildReadService(async () => ({ rows: [{ id: 'pool-1' }] }));

  assert.deepEqual(await service.listByCampaign('campaign-1'), [{ id: 'pool-1' }]);
  assert.deepEqual(await service.listByUser('user-1'), [{ id: 'pool-1' }]);

  assert.deepEqual(
    calls.map(call => call.params),
    [['campaign-1'], ['user-1']]
  );
  assert.match(calls[0].sql, /WHERE cp\.campaign_id = \$1/);
  assert.match(calls[1].sql, /WHERE cp\.leader_id = \$1/);
});

test('getById returns null for an absent pool and includes ordered members for an existing pool', async () => {
  let poolExists = false;
  const { service, calls } = buildReadService(async sql => {
    if (sql.includes('FROM contribution_pools')) {
      return { rows: poolExists ? [{ id: 'pool-1', member_count: 1 }] : [] };
    }
    return { rows: [{ id: 'member-1', user_id: 'user-1' }] };
  });

  assert.equal(await service.getById('missing'), null);
  poolExists = true;
  assert.deepEqual(await service.getById('pool-1'), {
    id: 'pool-1',
    member_count: 1,
    members: [{ id: 'member-1', user_id: 'user-1' }],
  });
  assert.equal(calls.filter(call => call.sql.includes('JOIN users')).length, 1);
});

test('create inserts all pool fields and returns the inserted row', async () => {
  const created = { id: 'pool-1', title: 'Group' };
  const { service, calls } = buildReadService(async () => ({ rows: [created] }));

  const result = await service.create({
    campaign_id: 'campaign-1',
    leader_id: 'leader-1',
    title: 'Group',
    description: 'Friends',
    target_amount: 100,
    expires_at: '2026-12-01',
  });

  assert.deepEqual(result, created);
  assert.deepEqual(calls[0].params, [
    'campaign-1',
    'leader-1',
    'Group',
    'Friends',
    100,
    '2026-12-01',
  ]);
});

test('leave rejects leaders and nonmembers, and deletes a member otherwise', async () => {
  let leaderId = 'leader-1';
  let rowCount = 1;
  const { service, calls } = buildReadService(async sql => {
    if (sql.includes('SELECT leader_id')) return { rows: [{ leader_id: leaderId }] };
    return { rows: [], rowCount };
  });

  await assert.rejects(() => service.leave('pool-1', 'leader-1'), /leader cannot leave/);
  leaderId = 'leader-1';
  rowCount = 0;
  await assert.rejects(() => service.leave('pool-1', 'member-1'), /Not a member/);
  rowCount = 1;
  await service.leave('pool-1', 'member-1');
  assert.deepEqual(calls[2].params, ['pool-1', 'member-1']);
});

test('update ignores unsupported fields and refuses edits to non-open pools', async () => {
  let status = 'open';
  const { service, calls } = buildReadService(async sql => {
    if (sql.startsWith('SELECT leader_id')) {
      return { rows: [{ leader_id: 'leader-1', status }] };
    }
    return { rows: [{ id: 'pool-1', title: 'Updated' }] };
  });

  const updated = await service.update('pool-1', 'leader-1', {
    title: 'Updated',
    id: 'injected',
    status: 'closed',
  });
  assert.deepEqual(updated, { id: 'pool-1', title: 'Updated' });
  assert.deepEqual(calls[1].params, ['Updated', 'closed', 'pool-1']);
  assert.match(
    calls[1].sql,
    /UPDATE contribution_pools SET title = \$1, status = \$2 WHERE id = \$3/
  );

  status = 'submitted';
  await assert.rejects(
    () => service.update('pool-1', 'leader-1', { title: 'Nope' }),
    /Can only edit open pools/
  );
});

// ---------------------------------------------------------------------------
// submitPool(): exercises the claim -> submit -> finalize/rollback lifecycle.
// ---------------------------------------------------------------------------
function buildSubmitService({
  pool,
  members,
  leader = {
    wallet_public_key: 'GLEADER',
    wallet_secret_encrypted: 'ENC',
    wallet_type: 'custodial',
  },
  campaign = { id: 'campaign-1', asset_type: 'USDC', status: 'active' },
  submitCustodialContributionImpl,
}) {
  const state = { pool: { ...pool }, statusHistory: [pool.status] };
  const finalizeCalls = [];

  function makeClient() {
    return {
      query: async (text, params) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
        if (/SELECT \* FROM contribution_pools WHERE id = \$1 FOR UPDATE/.test(text)) {
          return { rows: [{ ...state.pool }] };
        }
        if (/SELECT \* FROM pool_members WHERE pool_id = \$1 AND status = 'confirmed'/.test(text)) {
          return { rows: members };
        }
        if (/UPDATE contribution_pools SET status = 'submitting'/.test(text)) {
          state.pool.status = 'submitting';
          state.statusHistory.push('submitting');
          return { rows: [] };
        }
        if (/UPDATE contribution_pools SET status = 'submitted'/.test(text)) {
          state.pool.status = 'submitted';
          state.statusHistory.push('submitted');
          finalizeCalls.push({ text, params });
          return { rows: [] };
        }
        if (/UPDATE pool_members SET contributed_at/.test(text)) {
          finalizeCalls.push({ text, params });
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
  }

  const plainQuery = async (text, params) => {
    if (/SELECT wallet_public_key, wallet_secret_encrypted, wallet_type FROM users/.test(text)) {
      return { rows: [leader] };
    }
    if (
      /SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status FROM campaigns/.test(
        text
      )
    ) {
      return { rows: [campaign] };
    }
    if (
      /UPDATE contribution_pools SET status = \$1.*WHERE id = \$2 AND status = 'submitting'/.test(
        text
      )
    ) {
      state.pool.status = params[0];
      state.statusHistory.push(`rolled-back-to:${params[0]}`);
      return { rows: [] };
    }
    return { rows: [] };
  };

  const service = proxyquire('./poolQueries', {
    '../config/database': {
      connect: async () => makeClient(),
      query: plainQuery,
    },
    './contributionService': {
      submitCustodialContribution:
        submitCustodialContributionImpl || (async () => ({ txHash: 'txhash-abc' })),
    },
  });

  return { service, state, finalizeCalls };
}

test('submitPool finalizes the pool and stamps members on a successful Stellar submission', async () => {
  const { service, state, finalizeCalls } = buildSubmitService({
    pool: { id: 'pool-1', leader_id: 'leader-1', status: 'open', campaign_id: 'campaign-1' },
    members: [
      { user_id: 'a', share_amount: '40', status: 'confirmed' },
      { user_id: 'b', share_amount: '60', status: 'confirmed' },
    ],
  });

  const result = await service.submitPool('pool-1', 'leader-1');

  assert.equal(result.total_amount, 100);
  assert.equal(result.member_count, 2);
  assert.equal(result.tx_hash, 'txhash-abc');
  assert.equal(state.pool.status, 'submitted');
  assert.ok(finalizeCalls.some(c => /UPDATE pool_members SET contributed_at/.test(c.text)));
});

test('submitPool rolls the pool back to its prior status and does not finalize when the Stellar submission fails', async () => {
  const { service, state, finalizeCalls } = buildSubmitService({
    pool: { id: 'pool-1', leader_id: 'leader-1', status: 'open', campaign_id: 'campaign-1' },
    members: [{ user_id: 'a', share_amount: '40', status: 'confirmed' }],
    submitCustodialContributionImpl: async () => {
      throw new Error('Stellar submission failed');
    },
  });

  await assert.rejects(() => service.submitPool('pool-1', 'leader-1'), /Stellar submission failed/);

  assert.equal(state.pool.status, 'open', 'pool must not be left submitting or marked submitted');
  assert.equal(
    finalizeCalls.length,
    0,
    'no finalize/member-stamping queries should run on failure'
  );
});

test('submitPool rejects a Freighter-wallet leader without attempting any Stellar call', async () => {
  let called = false;
  const { service, state } = buildSubmitService({
    pool: { id: 'pool-1', leader_id: 'leader-1', status: 'open', campaign_id: 'campaign-1' },
    members: [{ user_id: 'a', share_amount: '40', status: 'confirmed' }],
    leader: {
      wallet_public_key: 'GFREIGHTER',
      wallet_secret_encrypted: null,
      wallet_type: 'freighter',
    },
    submitCustodialContributionImpl: async () => {
      called = true;
      return { txHash: 'should-not-happen' };
    },
  });

  await assert.rejects(
    () => service.submitPool('pool-1', 'leader-1'),
    /requires a custodial wallet for the leader/
  );
  assert.equal(called, false);
  assert.equal(state.pool.status, 'open');
});

test('submitPool rejects a non-leader caller', async () => {
  const { service } = buildSubmitService({
    pool: { id: 'pool-1', leader_id: 'leader-1', status: 'open', campaign_id: 'campaign-1' },
    members: [{ user_id: 'a', share_amount: '40', status: 'confirmed' }],
  });

  await assert.rejects(
    () => service.submitPool('pool-1', 'someone-else'),
    /Only the pool leader can submit/
  );
});

test('submitPool rejects a pool that is already submitting or submitted (double-submit)', async () => {
  const { service } = buildSubmitService({
    pool: { id: 'pool-1', leader_id: 'leader-1', status: 'submitted', campaign_id: 'campaign-1' },
    members: [{ user_id: 'a', share_amount: '40', status: 'confirmed' }],
  });

  await assert.rejects(() => service.submitPool('pool-1', 'leader-1'), /Pool is not open/);
});
