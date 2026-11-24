const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const INCIDENT_ID = '11111111-2222-3333-4444-555555555555';

function loadDetector({
  query = async () => ({ rows: [] }),
  safeFetch = async () => ({ ok: true }),
} = {}) {
  const logs = { info: [], warn: [], error: [] };
  const logger = {
    info: (message, meta) => logs.info.push({ message, meta }),
    warn: (message, meta) => logs.warn.push({ message, meta }),
    error: (message, meta) => logs.error.push({ message, meta }),
  };
  const detector = proxyquire('./incidentDetector', {
    '../../config/database': { query },
    '../../config/logger': logger,
    '../../utils/safeFetch': { safeFetch },
  });
  return { detector, logs };
}

function saveEnv(names) {
  const saved = new Map(names.map(name => [name, process.env[name]]));
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function healthySnapshot(overrides = {}) {
  return {
    platform_wallet: { public_key: 'GDEVELOPER' },
    campaign_wallets: { wallets: [] },
    raw_metrics: {
      horizon_testnet_ok: true,
      horizon_testnet_latency: 10,
      sse_dropped_streams_count: 0,
      platform_wallet_balance_xlm: 25,
      campaign_wallets_at_risk_count: 0,
      stuck_pending_contributions_count: 0,
      db_longest_query_seconds: 0,
      db_pool_utilisation: 20,
      ...overrides,
    },
  };
}

function makeIncidentRow(type, severity = 'warning') {
  return {
    id: INCIDENT_ID,
    incident_type: type,
    severity,
    status: 'open',
    triggered_at: '2026-01-01T00:00:00Z',
    triggering_metric_values: {},
    details: {},
  };
}

test('evaluateIncidentConditions uses exact threshold boundaries', () => {
  const { detector } = loadDetector();
  const { evaluateIncidentConditions } = detector;

  const atBoundaries = evaluateIncidentConditions(
    healthySnapshot({
      horizon_testnet_latency: detector.HORIZON_WARN_LATENCY_MS,
      platform_wallet_balance_xlm: detector.PLATFORM_MIN_XLM,
      db_longest_query_seconds: detector.SLOW_QUERY_SECONDS,
    })
  );
  assert.deepEqual(atBoundaries, []);

  const warning = evaluateIncidentConditions(
    healthySnapshot({
      horizon_testnet_latency: detector.HORIZON_WARN_LATENCY_MS + 1,
      sse_dropped_streams_count: 1,
      db_longest_query_seconds: detector.SLOW_QUERY_SECONDS + 0.1,
    })
  );
  assert.deepEqual(warning.map(incident => incident.type).sort(), [
    'database_slow_query',
    'horizon_latency_high',
    'sse_stream_dropped',
  ]);
  assert.equal(
    warning.find(incident => incident.type === 'horizon_latency_high').severity,
    'warning'
  );

  const critical = evaluateIncidentConditions(
    healthySnapshot({
      horizon_testnet_latency: detector.HORIZON_CRIT_LATENCY_MS + 1,
      platform_wallet_balance_xlm: detector.PLATFORM_MIN_XLM - 0.01,
    })
  );
  assert.deepEqual(critical.map(incident => incident.type).sort(), [
    'horizon_latency_critical',
    'platform_wallet_low_xlm',
  ]);
  assert.equal(
    critical.every(incident => incident.severity === 'critical'),
    true
  );
});

test('runIncidentDetectionCycle inserts new conditions once and dispatches webhooks', async () => {
  const restoreEnv = saveEnv(['OPS_WEBHOOK_URL', 'OPS_ALERT_EMAIL']);
  process.env.OPS_WEBHOOK_URL = 'https://ops.example.test/hook';
  delete process.env.OPS_ALERT_EMAIL;

  const calls = { queries: [], fetches: [] };
  const { detector } = loadDetector({
    query: async (text, params) => {
      calls.queries.push({ text, params });
      if (text.includes('FROM incidents')) return { rows: [] };
      if (text.includes('INSERT INTO incidents')) {
        return {
          rows: [
            {
              id: `incident-${calls.queries.length}`,
              incident_type: params[0],
              severity: params[1],
              status: 'open',
              triggering_metric_values: JSON.parse(params[2]),
              details: JSON.parse(params[3]),
            },
          ],
        };
      }
      return { rows: [] };
    },
    safeFetch: async (url, init) => {
      calls.fetches.push({ url, payload: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  try {
    await detector.runIncidentDetectionCycle(
      healthySnapshot({
        horizon_testnet_ok: false,
        horizon_testnet_latency: 6000,
        sse_dropped_streams_count: 2,
      })
    );
  } finally {
    restoreEnv();
  }

  const inserts = calls.queries.filter(call => call.text.includes('INSERT INTO incidents'));
  assert.deepEqual(inserts.map(call => call.params[0]).sort(), [
    'horizon_latency_critical',
    'sse_stream_dropped',
  ]);
  assert.equal(calls.fetches.length, 2);
  assert.equal(
    calls.fetches.every(call => call.payload.event === 'incident.triggered'),
    true
  );
});

test('an ongoing incident updates metrics instead of inserting a duplicate', async () => {
  const calls = { updates: [], inserts: 0 };
  const existing = makeIncidentRow('horizon_latency_high');
  const { detector } = loadDetector({
    query: async (text, params) => {
      if (text.includes('FROM incidents')) return { rows: [existing] };
      if (text.includes('INSERT INTO incidents')) {
        calls.inserts += 1;
        return { rows: [] };
      }
      if (text.includes('UPDATE incidents')) {
        calls.updates.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  await detector.runIncidentDetectionCycle(healthySnapshot({ horizon_testnet_latency: 2500 }));

  assert.equal(calls.inserts, 0);
  assert.equal(calls.updates.length, 1);
  assert.deepEqual(JSON.parse(calls.updates[0][0]), { latency_ms: 2500 });
  assert.equal(calls.updates[0][2], INCIDENT_ID);
});

test('recovered incidents are resolved and dispatch a resolved webhook', async () => {
  const restoreEnv = saveEnv(['OPS_WEBHOOK_URL', 'OPS_ALERT_EMAIL']);
  process.env.OPS_WEBHOOK_URL = 'https://ops.example.test/hook';
  delete process.env.OPS_ALERT_EMAIL;

  const fetches = [];
  const updates = [];
  const existing = makeIncidentRow('sse_stream_dropped');
  const { detector } = loadDetector({
    query: async (text, params) => {
      if (text.includes('FROM incidents')) return { rows: [existing] };
      if (text.includes("SET status = 'resolved'")) {
        updates.push(params);
        return { rows: [{ ...existing, status: 'resolved', duration_seconds: 42 }] };
      }
      return { rows: [] };
    },
    safeFetch: async (_url, init) => {
      fetches.push(JSON.parse(init.body));
      return { ok: true };
    },
  });

  try {
    await detector.runIncidentDetectionCycle(healthySnapshot());
  } finally {
    restoreEnv();
  }

  assert.deepEqual(updates, [[INCIDENT_ID]]);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].event, 'incident.resolved');
  assert.equal(fetches[0].incident_id, INCIDENT_ID);
});

test('an unavailable incidents table aborts the cycle without writes', async () => {
  const queries = [];
  const { detector, logs } = loadDetector({
    query: async text => {
      queries.push(text);
      throw new Error('connection refused');
    },
  });

  await detector.runIncidentDetectionCycle(healthySnapshot());

  assert.equal(queries.length, 1);
  assert.equal(
    logs.warn.some(entry => /open incidents/.test(entry.message)),
    true
  );
  assert.equal(logs.error.length, 0);
});

test('a failing webhook is logged but does not fail incident detection', async () => {
  const restoreEnv = saveEnv(['OPS_WEBHOOK_URL', 'OPS_ALERT_EMAIL']);
  process.env.OPS_WEBHOOK_URL = 'https://ops.example.test/hook';
  delete process.env.OPS_ALERT_EMAIL;

  const { detector, logs } = loadDetector({
    query: async (text, params) => {
      if (text.includes('FROM incidents')) return { rows: [] };
      if (text.includes('INSERT INTO incidents')) {
        return {
          rows: [
            {
              id: INCIDENT_ID,
              incident_type: params[0],
              severity: params[1],
              status: 'open',
            },
          ],
        };
      }
      return { rows: [] };
    },
    safeFetch: async () => {
      throw new Error('webhook unavailable');
    },
  });

  try {
    await detector.runIncidentDetectionCycle(healthySnapshot({ sse_dropped_streams_count: 1 }));
  } finally {
    restoreEnv();
  }

  assert.equal(
    logs.warn.some(entry => /webhook/.test(entry.message)),
    true
  );
  assert.equal(logs.error.length, 0);
});
