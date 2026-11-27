const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const proxyquire = require('proxyquire').noCallThru();

const DB_ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'DB_POOL_MAX',
  'DB_IDLE_TIMEOUT_MS',
  'DB_CONNECTION_TIMEOUT_MS',
  'DB_POOL_WAITING_THRESHOLD',
  'LOG_LEVEL',
];

/**
 * Loads a fresh copy of database.js against a fake pg Pool and a recording
 * logger, with the given env overrides applied (undefined removes a key).
 */
function loadDatabase(envOverrides = {}) {
  const saved = {};
  for (const key of DB_ENV_KEYS) saved[key] = process.env[key];

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';
  for (const key of ['DB_POOL_MAX', 'DB_IDLE_TIMEOUT_MS', 'DB_CONNECTION_TIMEOUT_MS']) {
    delete process.env[key];
  }
  delete process.env.DB_POOL_WAITING_THRESHOLD;
  delete process.env.LOG_LEVEL;
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const poolInstances = [];
  class FakePool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
      poolInstances.push(this);
    }
  }

  const logs = [];
  const logger = {
    error: (message, meta) => logs.push({ level: 'error', message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
    info: (message, meta) => logs.push({ level: 'info', message, meta }),
    debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
  };

  try {
    const db = proxyquire('./database', {
      pg: { Pool: FakePool },
      './logger': logger,
    });
    return { db, pool: poolInstances[0], poolInstances, logs };
  } finally {
    for (const key of DB_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('database: requires DATABASE_URL outside the test environment', () => {
  assert.throws(
    () => loadDatabase({ NODE_ENV: 'production', DATABASE_URL: undefined }),
    /DATABASE_URL environment variable is required/
  );
});

test('database: allows a missing DATABASE_URL under NODE_ENV=test', () => {
  const { pool } = loadDatabase({ DATABASE_URL: undefined });
  assert.equal(pool.options.connectionString, undefined);
});

test('database: creates exactly one pool with documented defaults', () => {
  const { db, pool, poolInstances } = loadDatabase();
  assert.equal(poolInstances.length, 1);
  assert.equal(db, pool, 'module exports the pool itself');
  assert.equal(pool.options.max, 10);
  assert.equal(pool.options.idleTimeoutMillis, 30000);
  assert.equal(pool.options.connectionTimeoutMillis, 5000);
  assert.equal(db.poolMax, 10);
});

test('database: honours pool limit and timeout overrides', () => {
  const { db, pool } = loadDatabase({
    DB_POOL_MAX: '25',
    DB_IDLE_TIMEOUT_MS: '1000',
    DB_CONNECTION_TIMEOUT_MS: '2500',
  });
  assert.equal(pool.options.max, 25);
  assert.equal(pool.options.idleTimeoutMillis, 1000);
  assert.equal(pool.options.connectionTimeoutMillis, 2500);
  assert.equal(db.poolMax, 25);
});

test('database: empty-string overrides fall back to defaults', () => {
  const { pool } = loadDatabase({ DB_POOL_MAX: '', DB_IDLE_TIMEOUT_MS: '' });
  assert.equal(pool.options.max, 10);
  assert.equal(pool.options.idleTimeoutMillis, 30000);
});

for (const [name, value] of [
  ['DB_POOL_MAX', '0'],
  ['DB_POOL_MAX', '-1'],
  ['DB_POOL_MAX', '10.5'],
  ['DB_POOL_MAX', 'abc'],
  ['DB_IDLE_TIMEOUT_MS', '0'],
  ['DB_CONNECTION_TIMEOUT_MS', '1e3'],
  ['DB_POOL_WAITING_THRESHOLD', '-1'],
  ['DB_POOL_WAITING_THRESHOLD', 'many'],
]) {
  test(`database: rejects invalid ${name}=${JSON.stringify(value)}`, () => {
    assert.throws(() => loadDatabase({ [name]: value }), new RegExp(`${name} must be a`));
  });
}

test('database: DB_POOL_WAITING_THRESHOLD accepts zero', () => {
  const { db, pool, logs } = loadDatabase({ DB_POOL_WAITING_THRESHOLD: '0' });
  pool.waitingCount = 1;
  db.getPoolMetrics();
  assert.equal(logs.filter(l => l.level === 'warn').length, 1);
});

test('database: TLS settings in DATABASE_URL reach pg unchanged in production', () => {
  // TLS is configured through the connection string (e.g. sslmode=require);
  // the pool must pass it through verbatim and not override it with an ssl option.
  const url = 'postgres://app:pw@db.example.com:5432/crowdpay?sslmode=require';
  const { pool } = loadDatabase({ NODE_ENV: 'production', DATABASE_URL: url });
  assert.equal(pool.options.connectionString, url);
  assert.equal(
    Object.prototype.hasOwnProperty.call(pool.options, 'ssl'),
    false,
    'no explicit ssl option that would override sslmode in the URL'
  );
});

test('database: pool errors are logged instead of crashing the process', () => {
  const { pool, logs } = loadDatabase();
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', new Error('connection terminated unexpectedly')));
  assert.deepEqual(logs, [
    {
      level: 'error',
      message: 'Unexpected database pool error',
      meta: { error: 'connection terminated unexpectedly' },
    },
  ]);
});

test('database: connect events only log at debug level', () => {
  const quiet = loadDatabase();
  quiet.pool.emit('connect');
  assert.equal(quiet.logs.length, 0);

  // LOG_LEVEL is read when the event fires, not at module load.
  const verbose = loadDatabase();
  verbose.pool.totalCount = 3;
  verbose.pool.idleCount = 1;
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  try {
    verbose.pool.emit('connect');
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
  assert.equal(verbose.logs.length, 1);
  assert.equal(verbose.logs[0].level, 'debug');
  assert.deepEqual(verbose.logs[0].meta, { total: 3, idle: 1, waiting: 0 });
});

test('database: getPoolMetrics reports counts and utilisation', () => {
  const { db, pool, logs } = loadDatabase({ DB_POOL_MAX: '8' });
  pool.totalCount = 5;
  pool.idleCount = 2;
  pool.waitingCount = 1;
  assert.deepEqual(db.getPoolMetrics(), {
    total: 5,
    idle: 2,
    waiting: 1,
    max: 8,
    utilisation: 37.5,
  });
  assert.equal(logs.length, 0, 'no warning below the waiting threshold');
});

test('database: getPoolMetrics rounds utilisation to two decimals', () => {
  const { db, pool } = loadDatabase({ DB_POOL_MAX: '3' });
  pool.totalCount = 1;
  assert.equal(db.getPoolMetrics().utilisation, 33.33);
});

test('database: getPoolMetrics warns only when waiting exceeds the threshold', () => {
  const { db, pool, logs } = loadDatabase({ DB_POOL_WAITING_THRESHOLD: '2' });

  pool.waitingCount = 2;
  db.getPoolMetrics();
  assert.equal(logs.length, 0, 'equal to threshold is not pressure');

  pool.waitingCount = 3;
  pool.totalCount = 10;
  db.getPoolMetrics();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /pool under pressure/);
  assert.equal(logs[0].meta.waiting, 3);
  assert.equal(logs[0].meta.threshold, 2);
  assert.equal(logs[0].meta.utilisation, 100);
});
