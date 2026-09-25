const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = './stellarTransactionService';
const DB_PATH = require.resolve('../config/database');

function loadService(db) {
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: db,
  };
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

test('insertContributionPending inserts a row and returns reused:false', async () => {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [{ id: 'tx-1' }] };
    },
  };
  const svc = loadService(db);

  const result = await svc.insertContributionPending(undefined, {
    campaignId: 'c-1',
    userId: 'u-1',
    unsignedXdr: 'u',
    signedXdr: 's',
    metadata: { flow: 'payment' },
  });

  assert.deepEqual(result, { id: 'tx-1', reused: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO stellar_transactions/);
  assert.deepEqual(calls[0].params.slice(0, 5), ['c-1', 'u-1', 'u', 's', '{"flow":"payment"}']);
});

test('insertContributionPending with an existing idempotency key reuses the row', async () => {
  const db = {
    async query(text, params) {
      if (text.includes('SELECT id, status, tx_hash')) {
        return { rows: [{ id: 'tx-existing', status: 'pending_signatures', tx_hash: null }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const svc = loadService(db);

  const result = await svc.insertContributionPending(undefined, {
    campaignId: 'c-1',
    userId: 'u-1',
    idempotencyKey: 'idem-1',
    unsignedXdr: 'u',
  });

  assert.deepEqual(result, {
    id: 'tx-existing',
    reused: true,
    status: 'pending_signatures',
    txHash: null,
  });
});

test('insertContributionPending with a fresh idempotency key still inserts', async () => {
  let selectCalls = 0;
  const db = {
    async query(text, params) {
      if (text.includes('SELECT id, status, tx_hash')) {
        selectCalls += 1;
        return { rows: [] };
      }
      return { rows: [{ id: 'tx-new' }] };
    },
  };
  const svc = loadService(db);

  const result = await svc.insertContributionPending(undefined, {
    campaignId: 'c-1',
    userId: 'u-1',
    idempotencyKey: 'idem-2',
    unsignedXdr: 'u',
    signedXdr: 's',
    metadata: {},
  });

  assert.deepEqual(result, { id: 'tx-new', reused: false });
  assert.equal(selectCalls, 1);
});

test('insertContributionPending honours a passed-in client over the module db', async () => {
  const client = {
    async query() {
      return { rows: [{ id: 'tx-client' }] };
    },
  };
  const svc = loadService({ query: async () => { throw new Error('should not hit module db'); } });

  const result = await svc.insertContributionPending(client, {
    campaignId: 'c-1',
    userId: 'u-1',
    unsignedXdr: 'u',
  });
  assert.equal(result.id, 'tx-client');
});

test('markContributionSubmitted updates status to submitted with tx_hash', async () => {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const svc = loadService(db);

  await svc.markContributionSubmitted(undefined, 'tx-1', 'abc123');

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /SET status = 'submitted', tx_hash = \$1/);
  assert.deepEqual(calls[0].params, ['abc123', 'tx-1']);
});

test('markContributionFailed updates status to failed with failure_reason', async () => {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const svc = loadService(db);

  await svc.markContributionFailed(undefined, 'tx-1', 'budget exceeded');

  assert.match(calls[0].text, /SET status = 'failed', failure_reason = \$1/);
  assert.deepEqual(calls[0].params, ['budget exceeded', 'tx-1']);
});

test('insertContributionSubmitted inserts a submitted row and returns its id', async () => {
  let captured;
  const db = {
    async query(text, params) {
      captured = { text, params };
      return { rows: [{ id: 'tx-sub' }] };
    },
  };
  const svc = loadService(db);

  const id = await svc.insertContributionSubmitted(undefined, {
    txHash: 'abcdef',
    campaignId: 'c-1',
    userId: 'u-1',
    unsignedXdr: 'u',
    signedXdr: 's',
    metadata: { platform_fee_amount: 0.15 },
  });

  assert.equal(id, 'tx-sub');
  assert.match(captured.text, /VALUES \('contribution', 'submitted'/);
  assert.deepEqual(captured.params.slice(0, 3), ['abcdef', 'c-1', 'u-1']);
  assert.equal(captured.params[5], '{"platform_fee_amount":0.15}');
});

test('insertWithdrawalPendingSignatures inserts a withdrawal row', async () => {
  const db = {
    async query(text, params) {
      assert.match(text, /'withdrawal', 'pending_signatures'/);
      assert.deepEqual(params.slice(0, 4), ['c-1', 'wr-1', 'u-1', 'unsigned']);
      return { rows: [{ id: 'wtx-1' }] };
    },
  };
  const svc = loadService(db);

  const id = await svc.insertWithdrawalPendingSignatures(undefined, {
    campaignId: 'c-1',
    withdrawalRequestId: 'wr-1',
    userId: 'u-1',
    unsignedXdr: 'unsigned',
    metadata: { currency: 'XLM' },
  });
  assert.equal(id, 'wtx-1');
});

test('markContributionIndexed sets contribution_id for a tx hash', async () => {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const svc = loadService(db);

  await svc.markContributionIndexed(undefined, '0xhex', 'con-9');

  assert.match(calls[0].text, /SET status = 'indexed', contribution_id = \$1/);
  assert.match(calls[0].text, /kind = 'contribution'/);
  assert.deepEqual(calls[0].params, ['con-9', '0xhex']);
});

test('finalizeWithdrawalSubmitted updates a withdrawal to submitted', async () => {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const svc = loadService(db);

  await svc.finalizeWithdrawalSubmitted(undefined, {
    withdrawalRequestId: 'wr-1',
    txHash: 'hash1',
    signedXdr: 'signed-xdr',
  });

  assert.match(calls[0].text, /withdrawal_request_id = \$3 AND kind = 'withdrawal'/);
  assert.deepEqual(calls[0].params, ['hash1', 'signed-xdr', 'wr-1']);
});

test('markWithdrawalFailed defaults the failure reason', async () => {
  const calls = [];
  const db = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const svc = loadService(db);

  await svc.markWithdrawalFailed(undefined, { withdrawalRequestId: 'wr-2' });

  assert.deepEqual(calls[0].params, ['unknown', 'wr-2']);
});

test('insertContributionAdjustment inserts a system reconciliation row', async () => {
  let captured;
  const db = {
    async query(text, params) {
      captured = { text, params };
      return { rows: [{ id: 'adj-1' }] };
    },
  };
  const svc = loadService(db);

  const id = await svc.insertContributionAdjustment(undefined, {
    campaignId: 'c-1',
    amount: '1.25',
    assetType: 'USDC',
  });

  assert.equal(id, 'adj-1');
  assert.match(captured.text, /'reconciliation_adjustment'/);
  assert.deepEqual(captured.params.slice(0, 3), ['c-1', '1.25', 'USDC']);
});

test('insertReconciliationAdjustment embeds the diff payload in metadata', async () => {
  let captured;
  const db = {
    async query(text, params) {
      captured = { text, params };
      return { rows: [{ id: 'rec-1' }] };
    },
  };
  const svc = loadService(db);

  const id = await svc.insertReconciliationAdjustment(undefined, {
    campaignId: 'c-1',
    dbBalance: '5',
    liveBalance: '4.5',
    diff: '-0.5',
    assetType: 'USDC',
  });

  assert.equal(id, 'rec-1');
  const metadata = JSON.parse(captured.params[1]);
  assert.equal(metadata.source, 'reconciliation_adjustment');
  assert.equal(metadata.diff, '-0.5');
  assert.equal(metadata.asset_type, 'USDC');
});