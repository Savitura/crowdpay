const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

const PLATFORM_PUBLIC_KEY = Keypair.random().publicKey();
const CAMPAIGN_WALLET = Keypair.random().publicKey();

function saveEnv(names) {
  const saved = new Map(names.map(name => [name, process.env[name]]));
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function makeServer() {
  return {
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({
            records: [
              {
                closed_at: new Date(Date.now() - 60_000).toISOString(),
                sequence: '123',
              },
            ],
          }),
        }),
      }),
    }),
    loadAccount: async publicKey =>
      publicKey === PLATFORM_PUBLIC_KEY
        ? { balances: [{ asset_type: 'native', balance: '8' }] }
        : {
            balances: [
              { asset_type: 'native', balance: '0.2' },
              { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' },
            ],
          },
  };
}

function loadCollector({ query, streams }) {
  const logs = { info: [], warn: [], error: [] };
  const logger = {
    info: (message, meta) => logs.info.push({ message, meta }),
    warn: (message, meta) => logs.warn.push({ message, meta }),
    error: (message, meta) => logs.error.push({ message, meta }),
  };
  const collector = proxyquire('./healthCollector', {
    '../../config/database': {
      query,
      getPoolMetrics: () => ({ total: 10, idle: 1, waiting: 9, max: 10, utilisation: 92 }),
    },
    '../../config/logger': logger,
    '../../config/stellar': { server: makeServer(), isTestnet: true },
    '../ledgerMonitor': {
      getLedgerStreamHealth: async () => streams,
    },
  });
  return { collector, logs };
}

test('collectHealthMetrics flags every breached threshold and persists breach metadata', async () => {
  const restoreFetch = global.fetch;
  const restoreEnv = saveEnv(['STELLAR_HORIZON_URL', 'PLATFORM_PUBLIC_KEY', 'PLATFORM_SECRET_KEY']);
  process.env.STELLAR_HORIZON_URL = 'https://testnet.example.test/';
  process.env.PLATFORM_PUBLIC_KEY = PLATFORM_PUBLIC_KEY;
  delete process.env.PLATFORM_SECRET_KEY;

  const fetches = [];
  const inserts = [];
  const queries = [];
  global.fetch = async url => {
    fetches.push(url);
    if (url.startsWith('https://testnet.example.test')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ last_ledger_seq: '123' }),
      };
    }
    return { ok: false, status: 503 };
  };

  const streams = {
    active_campaigns: 2,
    streams: [
      { stream_state: 'connected' },
      { stream_state: 'not_connected' },
      { stream_state: 'connected', stale_stream_no_messages_15m: true },
    ],
  };
  const { collector } = loadCollector({
    streams,
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM stellar_transactions'))
        return { rows: [{ id: 'tx-1', is_stale: true }] };
      if (text.includes('FROM campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Campaign',
              wallet_public_key: CAMPAIGN_WALLET,
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('FROM pg_stat_activity')) return { rows: [{ duration_sec: 6.2 }] };
      if (text.includes('FROM contributions')) return { rows: [{ id: 'contribution-1' }] };
      if (text.includes('FROM withdrawal_requests')) return { rows: [{ id: 'withdrawal-1' }] };
      if (text.includes('INSERT INTO ops_metrics')) {
        inserts.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  try {
    const snapshot = await collector.collectHealthMetrics();

    assert.equal(snapshot.horizon.testnet.ok, true);
    assert.equal(snapshot.horizon.mainnet.ok, false);
    assert.ok(snapshot.raw_metrics.ledger_staleness_seconds > 10);
    assert.equal(snapshot.raw_metrics.sse_active_connections, 2);
    assert.equal(snapshot.raw_metrics.sse_dropped_streams_count, 2);
    assert.equal(snapshot.raw_metrics.platform_wallet_balance_xlm, 8);
    assert.equal(snapshot.raw_metrics.platform_wallet_is_low, true);
    assert.equal(snapshot.raw_metrics.campaign_wallets_at_risk_count, 1);
    assert.equal(snapshot.raw_metrics.db_pool_utilisation, 92);
    assert.equal(snapshot.raw_metrics.db_longest_query_seconds, 6.2);
    assert.equal(snapshot.raw_metrics.stuck_pending_contributions_count, 1);
    assert.equal(snapshot.raw_metrics.stuck_pending_withdrawals_count, 1);
    assert.equal(snapshot.system_health_score, 0);
    assert.equal(collector.getLatestHealthSnapshot(), snapshot);

    const breaches = new Map(inserts.map(params => [params[1], params[4]]));
    assert.equal(inserts.length, 11);
    assert.equal(breaches.get('horizon_testnet_latency_ms'), false);
    assert.equal(breaches.get('ledger_staleness_seconds'), true);
    assert.equal(breaches.get('sse_dropped_streams_count'), true);
    assert.equal(breaches.get('platform_wallet_balance_xlm'), true);
    assert.equal(breaches.get('campaign_wallets_at_risk_count'), true);
    assert.equal(breaches.get('db_pool_utilisation'), true);
    assert.equal(breaches.get('db_longest_query_seconds'), true);
    assert.equal(breaches.get('stuck_pending_contributions_count'), true);
    assert.equal(breaches.get('stuck_pending_withdrawals_count'), true);
    assert.ok(queries.some(call => call.text.includes('INSERT INTO ops_metrics')));
    assert.deepEqual(fetches, [
      'https://testnet.example.test/fee_stats',
      'https://horizon.stellar.org/fee_stats',
    ]);
  } finally {
    global.fetch = restoreFetch;
    restoreEnv();
  }
});

test('computeSystemHealthScore clamps penalties and respects threshold boundaries', () => {
  const { collector } = loadCollector({
    query: async () => ({ rows: [] }),
    streams: { streams: [] },
  });
  const { computeSystemHealthScore } = collector;

  assert.equal(
    computeSystemHealthScore({ horizon_testnet_ok: true, platform_wallet_balance_xlm: 10 }),
    100
  );
  assert.equal(
    computeSystemHealthScore({
      horizon_testnet_ok: true,
      horizon_testnet_latency: 5000,
      platform_wallet_balance_xlm: 10,
      db_longest_query_seconds: 5,
      db_pool_utilisation: 90,
    }),
    75
  );
  assert.equal(
    computeSystemHealthScore({
      horizon_testnet_ok: false,
      ledger_staleness_seconds: 11,
      sse_dropped_streams_count: 5,
      platform_wallet_balance_xlm: 0,
      campaign_wallets_at_risk_count: 10,
      db_pool_utilisation: 95,
      db_longest_query_seconds: 6,
      stuck_pending_contributions_count: 10,
    }),
    0
  );
});
