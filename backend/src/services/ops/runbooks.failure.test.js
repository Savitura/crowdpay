const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

const INCIDENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PLATFORM_PUBLIC_KEY = Keypair.random().publicKey();
const CAMPAIGN_A = Keypair.random().publicKey();
const CAMPAIGN_B = Keypair.random().publicKey();

function saveEnv(names) {
  const saved = new Map(names.map(name => [name, process.env[name]]));
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function makeQuery({
  incident = { id: INCIDENT_ID, incident_type: 'platform_wallet_low_xlm' },
  campaigns = [],
  stuck = [],
  executionId = 'execution-1',
} = {}) {
  const calls = { queries: [], updateExecutions: [], contributionUpdates: [] };
  const query = async (text, params) => {
    calls.queries.push({ text, params });
    if (text.includes('FROM incidents')) return { rows: incident ? [incident] : [] };
    if (text.includes('INSERT INTO runbook_executions')) return { rows: [{ id: executionId }] };
    if (text.includes('UPDATE runbook_executions')) {
      calls.updateExecutions.push(params);
      return { rows: [] };
    }
    if (text.includes('FROM campaigns')) return { rows: campaigns };
    if (text.includes('FROM contributions')) return { rows: stuck };
    if (text.includes('UPDATE contributions')) {
      calls.contributionUpdates.push(params);
      return { rows: [] };
    }
    if (text.includes('FROM stellar_transactions')) return { rows: [] };
    return { rows: [] };
  };
  return { query, calls };
}

function loadRunbooks({
  query = async () => ({ rows: [] }),
  safeFetch = async () => ({ ok: true }),
  auditPlatformWallet = async () => ({ balance_xlm: 20, pending_transactions_count: 0 }),
  auditCampaignWallets = async () => ({ wallets: [] }),
  cleanupStreamForWallet = () => {},
  watchCampaignWallet = () => {},
  transactionCall = async () => ({ successful: false }),
} = {}) {
  const logs = { info: [], warn: [], error: [] };
  const logger = {
    info: (message, meta) => logs.info.push({ message, meta }),
    warn: (message, meta) => logs.warn.push({ message, meta }),
    error: (message, meta) => logs.error.push({ message, meta }),
  };
  const server = {
    transactions: () => ({
      transaction: () => ({ call: transactionCall }),
    }),
    submitTransaction: async () => ({ hash: 'tx-hash' }),
  };
  const runbooks = proxyquire('./runbooks', {
    '../../config/database': { query },
    '../../config/logger': logger,
    '../../utils/safeFetch': { safeFetch },
    '../../config/stellar': { server, isTestnet: true },
    '../ledgerMonitor': { cleanupStreamForWallet, watchCampaignWallet },
    './healthCollector': {
      auditPlatformWallet,
      auditCampaignWallets,
      getPlatformPublicKey: () => PLATFORM_PUBLIC_KEY,
    },
  });
  return { runbooks, logs };
}

test('executeRunbook records a failed status when the handler throws', async () => {
  const { query, calls } = makeQuery();
  const { runbooks, logs } = loadRunbooks({
    query,
    auditPlatformWallet: async () => {
      throw new Error('horizon unavailable');
    },
  });

  const result = await runbooks.executeRunbook(INCIDENT_ID, 'runbook_refund_platform_wallet');

  assert.equal(result.status, 'failed');
  assert.equal(result.result, null);
  assert.ok(result.steps.some(step => step.name === 'Execution Error' && step.status === 'failed'));
  assert.equal(calls.updateExecutions.length, 1);
  assert.equal(calls.updateExecutions[0][0], 'failed');
  assert.match(calls.updateExecutions[0][1], /horizon unavailable/);
  assert.ok(logs.error.some(entry => /Runbook execution error/.test(entry.message)));
});

test('executeRunbook selects the suggested runbook and survives partial SSE failures', async () => {
  const campaigns = [
    { id: 'campaign-1', title: 'A', wallet_public_key: CAMPAIGN_A, last_cursor: 'cursor-1' },
    { id: 'campaign-2', title: 'B', wallet_public_key: CAMPAIGN_B, last_cursor: null },
  ];
  const { query } = makeQuery({
    incident: { id: INCIDENT_ID, incident_type: 'sse_stream_dropped' },
    campaigns,
  });
  const cleaned = [];
  const watched = [];
  const { runbooks } = loadRunbooks({
    query,
    cleanupStreamForWallet: key => cleaned.push(key),
    watchCampaignWallet: options => {
      watched.push(options);
      if (options.walletPublicKey === CAMPAIGN_B) throw new Error('stream refused');
    },
  });

  assert.equal(
    runbooks.getSuggestedRunbookForIncident('sse_stream_dropped'),
    'runbook_restart_sse_stream'
  );
  assert.equal(runbooks.getSuggestedRunbookForIncident('unmapped_incident'), null);

  const result = await runbooks.executeRunbook(INCIDENT_ID);

  assert.equal(result.runbook_type, 'runbook_restart_sse_stream');
  assert.equal(result.status, 'completed');
  assert.equal(result.result.reconnected_count, 1);
  assert.equal(result.result.total_campaigns, 2);
  assert.deepEqual(cleaned, [CAMPAIGN_A, CAMPAIGN_B]);
  assert.deepEqual(
    watched.map(options => options.cursor),
    ['cursor-1', undefined]
  );
  assert.ok(
    result.steps.some(step => step.name.startsWith('2. Reset Stream') && step.status === 'failed')
  );
});

test('executeRunbook rejects unsupported runbook types before creating an execution record', async () => {
  const { query, calls } = makeQuery({ incident: null });
  const { runbooks } = loadRunbooks({ query });

  await assert.rejects(
    () => runbooks.executeRunbook(null, 'runbook_delete_everything'),
    /Invalid or unsupported runbook type/
  );
  assert.equal(
    calls.queries.filter(call => call.text.includes('INSERT INTO runbook_executions')).length,
    0
  );
});

test('funding runbook still returns manual instructions when the approval webhook fails', async () => {
  const restoreEnv = saveEnv(['OPS_WEBHOOK_URL']);
  process.env.OPS_WEBHOOK_URL = 'https://ops.example.test/hook';
  const { query } = makeQuery({
    incident: { id: INCIDENT_ID, incident_type: 'campaign_wallet_underfunded' },
  });
  const { runbooks } = loadRunbooks({
    query,
    safeFetch: async () => {
      throw new Error('webhook down');
    },
    auditCampaignWallets: async () => ({
      wallets: [
        {
          campaign_id: 'campaign-1',
          campaign_title: 'Campaign',
          wallet_public_key: CAMPAIGN_A,
          balance_xlm: 0.2,
          min_required_xlm: 1.5,
          deficit_xlm: 1.3,
        },
      ],
    }),
  });

  try {
    const result = await runbooks.executeRunbook(INCIDENT_ID, 'runbook_fund_underfunded_wallet');

    assert.equal(result.status, 'requires_manual_action');
    assert.equal(result.result.underfunded_wallets.length, 1);
    assert.equal(result.result.underfunded_wallets[0].deficit_xlm, 1.3);
  } finally {
    restoreEnv();
  }
});

test('refund runbook blocks withdrawal co-signing and requests manual top-up', async () => {
  const { query } = makeQuery();
  const { runbooks } = loadRunbooks({
    query,
    auditPlatformWallet: async () => ({
      public_key: PLATFORM_PUBLIC_KEY,
      balance_xlm: 1,
      pending_transactions_count: 2,
      estimated_xlm_needed: 5.0001,
    }),
  });

  try {
    assert.equal(runbooks.isWithdrawalCoSigningBlocked(), false);
    const result = await runbooks.executeRunbook(INCIDENT_ID, 'runbook_refund_platform_wallet');

    assert.equal(result.status, 'requires_manual_action');
    assert.equal(runbooks.isWithdrawalCoSigningBlocked(), true);
    assert.match(result.result.action_required, /UNKNOWN_PUBLIC_KEY|Manual Action Required/);
    assert.ok(result.result.action_required.includes(PLATFORM_PUBLIC_KEY));
    assert.ok(
      result.steps.some(
        step => step.name === '2. Enforce Operational Safety' && step.status === 'completed'
      )
    );
  } finally {
    runbooks.setWithdrawalCoSigningBlocked(false);
  }
});

test('resubmit runbook marks already-confirmed contributions as indexed', async () => {
  const stuck = [
    {
      id: 'contribution-1',
      campaign_id: 'campaign-1',
      tx_hash: 'tx-hash-1',
      amount: '1',
      asset: 'native',
    },
  ];
  const { query, calls } = makeQuery({ stuck });
  const { runbooks } = loadRunbooks({
    query,
    transactionCall: async () => ({ successful: true }),
  });

  const result = await runbooks.executeRunbook(INCIDENT_ID, 'runbook_resubmit_stuck_contribution');

  assert.equal(result.status, 'completed');
  assert.equal(result.result.stuck_found, 1);
  assert.equal(result.result.indexed_confirmed, 1);
  assert.equal(result.result.fee_bumped_resubmitted, 0);
  assert.equal(calls.contributionUpdates.length, 1);
  assert.deepEqual(calls.contributionUpdates[0][0], 'contribution-1');
});
