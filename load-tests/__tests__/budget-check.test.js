'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, budgetFailures, compareToBudgets, checkJsPayload } = require('../budget-check');

const SCRIPT = path.join(__dirname, '..', 'budget-check.js');
const REAL_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'performance-budgets.json'), 'utf8')
);
const REAL_BASELINE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'performance-baseline.json'), 'utf8')
);

const clone = value => JSON.parse(JSON.stringify(value));

function makeConfig(overrides = {}) {
  return {
    version: 1,
    regression: { max_increase_percent: 20, min_absolute_ms: 25 },
    paths: {
      checkout: {
        label: 'Checkout',
        web: { lcp_ms: 3000, interaction_ms: 300, js_payload_kb: 10 },
        api: { p95_ms: 800, p99_ms: 2500, error_rate: 0.01 },
        k6: { latency_metric: 'checkout_latency', error_metric: 'checkout_errors' },
      },
    },
    exceptions: [],
    ...overrides,
  };
}

function makeBaseline(p95 = 400, p99 = 1000, errorRate = 0.002) {
  return { metrics: { checkout: { p95_ms: p95, p99_ms: p99, error_rate: errorRate } } };
}

function makeSummary(p95, p99, errorRate = 0) {
  return {
    metrics: {
      checkout_latency: { values: { 'p(95)': p95, 'p(99)': p99 } },
      checkout_errors: { values: { rate: errorRate } },
    },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'budget-check-'));
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('parseArgs reads values and ignores leading positionals', () => {
  assert.deepEqual(parseArgs(['stray', '--config', 'a.json', '--dist', 'dist']), {
    config: 'a.json',
    dist: 'dist',
  });
});

test('parseArgs treats a trailing flag as boolean', () => {
  assert.deepEqual(parseArgs(['--config', 'a.json', '--validate']), {
    config: 'a.json',
    validate: true,
  });
});

test('parseArgs treats a flag followed by another flag as boolean', () => {
  assert.deepEqual(parseArgs(['--validate', '--summary', 's.json']), {
    validate: true,
    summary: 's.json',
  });
});

test('committed budgets and baseline pass validation', () => {
  assert.deepEqual(budgetFailures(REAL_CONFIG, REAL_BASELINE), []);
});

test('budgetFailures rejects wrong version and empty paths', () => {
  assert.deepEqual(budgetFailures({ version: 2, paths: {} }), [
    'budget config version must be 1',
    'budget config must define at least one path',
  ]);
});

test('budgetFailures flags non-positive and missing web/api budgets', () => {
  const config = makeConfig();
  config.paths.checkout.web.lcp_ms = 0;
  delete config.paths.checkout.web.js_payload_kb;
  config.paths.checkout.api.p95_ms = -1;
  const failures = budgetFailures(config);
  assert.ok(failures.includes('Checkout: web.lcp_ms must be a positive number'));
  assert.ok(failures.includes('Checkout: web.js_payload_kb must be a positive number'));
  assert.ok(failures.includes('Checkout: api.p95_ms must be a positive number'));
});

test('budgetFailures bounds error_rate to [0, 1]', () => {
  for (const bad of [-0.1, 1.5, 'x']) {
    const config = makeConfig();
    config.paths.checkout.api.error_rate = bad;
    assert.ok(
      budgetFailures(config).includes('Checkout: api.error_rate must be between 0 and 1'),
      `error_rate ${bad} should fail`
    );
  }
  const edge = makeConfig();
  edge.paths.checkout.api.error_rate = 0;
  assert.deepEqual(budgetFailures(edge), []);
});

test('budgetFailures requires p99 >= p95', () => {
  const config = makeConfig();
  config.paths.checkout.api.p99_ms = 100;
  assert.ok(
    budgetFailures(config).includes(
      'Checkout: api.p99_ms must be greater than or equal to api.p95_ms'
    )
  );
});

test('budgetFailures requires k6 metric names', () => {
  const config = makeConfig();
  delete config.paths.checkout.k6.error_metric;
  assert.ok(
    budgetFailures(config).includes('Checkout: k6 latency_metric and error_metric are required')
  );
});

test('budgetFailures flags a baseline that is missing a configured path', () => {
  assert.ok(
    budgetFailures(makeConfig(), { metrics: { other: {} } }).includes(
      'baseline is missing metrics for checkout'
    )
  );
});

test('budgetFailures bounds regression.max_increase_percent', () => {
  for (const bad of [undefined, -1, 101]) {
    const config = makeConfig({ regression: { max_increase_percent: bad } });
    assert.ok(
      budgetFailures(config).includes('regression.max_increase_percent must be between 0 and 100'),
      `max_increase_percent ${bad} should fail`
    );
  }
});

test('budgetFailures validates exception owner, reason, metric, path and expiry', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const config = makeConfig({
    exceptions: [
      { path: 'missing', expires_at: 'not-a-date' },
      {
        path: 'checkout',
        metric: 'p95_ms',
        owner: 'perf-team',
        reason: 'migration',
        expires_at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  const failures = budgetFailures(config, undefined, now);
  assert.ok(failures.includes('exceptions[0].path must reference a configured path'));
  assert.ok(failures.includes('exceptions[0].metric is required'));
  assert.ok(failures.includes('exceptions[0].owner is required'));
  assert.ok(failures.includes('exceptions[0].reason is required'));
  assert.ok(failures.includes('exceptions[0].expires_at must be an ISO 8601 timestamp'));
  assert.ok(failures.some(f => f.startsWith('exceptions[1] expired at 2026-01-01T00:00:00Z')));
});

test('budgetFailures accepts a well-formed, unexpired exception', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const config = makeConfig({
    exceptions: [
      {
        path: 'checkout',
        metric: 'p95_ms',
        owner: 'perf-team',
        reason: 'migration',
        expires_at: '2026-12-01T00:00:00Z',
      },
    ],
  });
  assert.deepEqual(budgetFailures(config, undefined, now), []);
});

test('compareToBudgets passes when metrics are within budget and baseline tolerance', () => {
  const { failures, rows } = compareToBudgets(makeConfig(), makeBaseline(), makeSummary(420, 1100));
  assert.deepEqual(failures, []);
  assert.deepEqual(
    rows.map(r => [r.metric, r.status]),
    [
      ['p95_ms', 'OK'],
      ['p99_ms', 'OK'],
      ['error_rate', 'OK'],
    ]
  );
});

test('compareToBudgets fails when an absolute budget is exceeded', () => {
  const { failures } = compareToBudgets(
    makeConfig(),
    makeBaseline(790, 1000),
    makeSummary(900, 1000)
  );
  assert.deepEqual(failures, ['Checkout p95_ms: 900 ms exceeds budget 800 ms']);
});

test('compareToBudgets fails on regression above baseline + percent + noise floor', () => {
  // baseline 400 * 1.2 + 25 = 505
  const ok = compareToBudgets(makeConfig(), makeBaseline(), makeSummary(505, 1000));
  assert.deepEqual(ok.failures, []);
  const bad = compareToBudgets(makeConfig(), makeBaseline(), makeSummary(506, 1000));
  assert.deepEqual(bad.failures, ['Checkout p95_ms: 506 ms exceeds baseline 400 ms +20%']);
});

test('compareToBudgets reports both reasons when budget and regression are exceeded', () => {
  const { failures } = compareToBudgets(makeConfig(), makeBaseline(), makeSummary(900, 1000));
  assert.deepEqual(failures, [
    'Checkout p95_ms: 900 ms exceeds budget 800 ms and baseline 400 ms +20%',
  ]);
});

test('compareToBudgets fails when error rate exceeds budget', () => {
  const { failures, rows } = compareToBudgets(
    makeConfig(),
    makeBaseline(400, 1000, 0.02),
    makeSummary(400, 1000, 0.05)
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^Checkout error_rate: 5\.00% exceeds budget 1\.00%/);
  assert.equal(rows.find(r => r.metric === 'error_rate').status, 'FAIL');
});

test('compareToBudgets treats a missing error metric as zero errors', () => {
  const summary = makeSummary(400, 1000);
  delete summary.metrics.checkout_errors;
  assert.deepEqual(compareToBudgets(makeConfig(), makeBaseline(), summary).failures, []);
});

test('compareToBudgets fails when the K6 latency metric is absent', () => {
  const { failures, rows } = compareToBudgets(makeConfig(), makeBaseline(), { metrics: {} });
  assert.deepEqual(failures, ['Checkout: K6 summary is missing checkout_latency']);
  assert.deepEqual(rows, []);
});

test('compareToBudgets skips regression checks without a baseline but still enforces budgets', () => {
  const pass = compareToBudgets(makeConfig(), {}, makeSummary(700, 2000));
  assert.deepEqual(pass.failures, []);
  assert.equal(pass.rows[0].baseline, 'n/a');
  const fail = compareToBudgets(makeConfig(), {}, makeSummary(801, 2000));
  assert.deepEqual(fail.failures, ['Checkout p95_ms: 801 ms exceeds budget 800 ms']);
});

test('compareToBudgets lets an exception waive a failing metric', () => {
  const config = makeConfig({
    exceptions: [
      {
        path: 'checkout',
        metric: 'p95_ms',
        owner: 'perf-team',
        reason: 'known',
        expires_at: '2999-01-01T00:00:00Z',
      },
    ],
  });
  const { failures, rows } = compareToBudgets(config, makeBaseline(), makeSummary(900, 1000));
  assert.deepEqual(failures, []);
  assert.equal(rows.find(r => r.metric === 'p95_ms').status, 'EXCEPTION');
});

test('compareToBudgets exception only covers its own metric', () => {
  const config = makeConfig({
    exceptions: [
      { path: 'checkout', metric: 'p95_ms', owner: 'o', reason: 'r', expires_at: '2999-01-01' },
    ],
  });
  const { failures } = compareToBudgets(config, makeBaseline(400, 1000), makeSummary(900, 3000));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^Checkout p99_ms:/);
});

test('checkJsPayload is a no-op without a dist directory', () => {
  assert.deepEqual(checkJsPayload(makeConfig(), undefined), { failures: [], rows: [] });
});

test('checkJsPayload fails when the assets directory is missing', () => {
  const dir = tmpDir();
  const { failures } = checkJsPayload(makeConfig(), dir);
  assert.deepEqual(failures, [
    `JavaScript payload directory not found: ${path.join(dir, 'assets')}`,
  ]);
});

test('checkJsPayload sums only .js files and compares KB (rounded up) to the budget', () => {
  const dir = tmpDir();
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'a.js'), Buffer.alloc(6 * 1024));
  fs.writeFileSync(path.join(assets, 'b.js'), Buffer.alloc(4 * 1024));
  fs.writeFileSync(path.join(assets, 'style.css'), Buffer.alloc(50 * 1024));

  const atBudget = checkJsPayload(makeConfig(), dir); // 10 KB vs budget 10
  assert.deepEqual(atBudget.failures, []);
  assert.equal(atBudget.rows[0].actual, '10 KB');
  assert.equal(atBudget.rows[0].status, 'OK');

  fs.writeFileSync(path.join(assets, 'c.js'), Buffer.alloc(1));
  const over = checkJsPayload(makeConfig(), dir); // 10241 bytes -> 11 KB
  assert.deepEqual(over.failures, ['Checkout js_payload_kb: 11 KB exceeds budget 10 KB']);
  assert.equal(over.rows[0].status, 'FAIL');
});

test('CLI --validate succeeds on the committed config', () => {
  const result = runCli(['--validate']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Configuration valid: campaign_discovery, contribution_checkout/);
  assert.match(result.stdout, /\[perf-budget\] OK/);
});

test('CLI exits non-zero with usage hint when no mode is given', () => {
  const result = runCli([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /provide --validate, --summary <file>, or --dist/);
});

test('CLI --summary exits 1 on a regression and 0 within budget', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const baselinePath = path.join(dir, 'baseline.json');
  fs.writeFileSync(configPath, JSON.stringify(makeConfig()));
  fs.writeFileSync(baselinePath, JSON.stringify(makeBaseline()));

  const goodPath = path.join(dir, 'good.json');
  fs.writeFileSync(goodPath, JSON.stringify(makeSummary(410, 1000)));
  const good = runCli(['--summary', goodPath, '--config', configPath, '--baseline', baselinePath]);
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /OK/);

  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, JSON.stringify(makeSummary(900, 1000)));
  const bad = runCli(['--summary', badPath, '--config', configPath, '--baseline', baselinePath]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /\[perf-budget\] FAILED/);
  assert.match(bad.stderr, /Checkout p95_ms: 900 ms exceeds budget 800 ms/);
  assert.match(bad.stdout, /FAIL/);
});

test('CLI reports an unreadable summary file', () => {
  const result = runCli(['--summary', path.join(tmpDir(), 'missing.json')]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unable to read K6 summary/);
});
