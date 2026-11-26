const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Transport } = require('winston');
const { runWithContext } = require('./requestContext');

// winston stores the final formatted line under this symbol (triple-beam MESSAGE).
const MESSAGE = Symbol.for('message');
// The uncolourised level (info.level is colourised in development).
const LEVEL = Symbol.for('level');

const LOGGER_PATH = path.join(__dirname, 'logger.js');
const STELLAR_SECRET = 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR';
const STELLAR_PUBLIC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

class CaptureTransport extends Transport {
  constructor() {
    // No level of its own: inherits the logger's level like the console transport.
    super();
    this.entries = [];
  }

  log(info, callback) {
    this.entries.push(info);
    callback();
  }
}

/**
 * Loads a fresh logger with the given NODE_ENV / LOG_LEVEL and swaps the
 * console transport for one that records the fully formatted entries.
 */
function loadLogger({ nodeEnv = 'test', logLevel } = {}) {
  const saved = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL };
  process.env.NODE_ENV = nodeEnv;
  if (logLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = logLevel;

  delete require.cache[LOGGER_PATH];
  try {
    const logger = require(LOGGER_PATH);
    const capture = new CaptureTransport();
    logger.clear();
    logger.add(capture);
    return { logger, entries: capture.entries };
  } finally {
    delete require.cache[LOGGER_PATH];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('logger: redacts sensitive keys in metadata', () => {
  const { logger, entries } = loadLogger();
  logger.info('login', {
    authorization: 'Bearer abc.def.ghi',
    Authorization: 'Bearer upper',
    password: 'hunter2',
    jwtSecret: 'shh',
    accessToken: 'tok_123',
    refresh_token: 'tok_456',
    privateKey: 'pk',
    private_key: 'pk2',
    seedPhrase: 'twelve words',
    cookie: 'sid=1',
    userId: 'user-1',
  });

  const [entry] = entries;
  for (const key of [
    'authorization',
    'Authorization',
    'password',
    'jwtSecret',
    'accessToken',
    'refresh_token',
    'privateKey',
    'private_key',
    'seedPhrase',
    'cookie',
  ]) {
    assert.equal(entry[key], '[REDACTED]', `${key} should be redacted`);
  }
  assert.equal(entry.userId, 'user-1', 'non-sensitive keys are untouched');
  assert.equal(entry.message, 'login');
});

test('logger: redacts sensitive keys nested in objects and arrays', () => {
  const { logger, entries } = loadLogger();
  logger.info('outbound request', {
    request: { headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } },
    signers: [{ publicKey: STELLAR_PUBLIC, secret: 'x' }],
  });

  const [entry] = entries;
  assert.deepEqual(entry.request.headers, {
    authorization: '[REDACTED]',
    'content-type': 'application/json',
  });
  assert.deepEqual(entry.signers, [{ publicKey: STELLAR_PUBLIC, secret: '[REDACTED]' }]);
});

test('logger: redacts Stellar secret seeds under any key or in arrays', () => {
  const { logger, entries } = loadLogger();
  logger.info('wallet created', {
    wallet: { key: STELLAR_SECRET, address: STELLAR_PUBLIC },
    keys: [STELLAR_SECRET, STELLAR_PUBLIC],
  });

  const [entry] = entries;
  assert.equal(entry.wallet.key, '[REDACTED]');
  assert.equal(entry.wallet.address, STELLAR_PUBLIC, 'public keys are not secrets');
  assert.deepEqual(entry.keys, ['[REDACTED]', STELLAR_PUBLIC]);
});

test('logger: redacts a Stellar secret passed as the message itself', () => {
  const { logger, entries } = loadLogger();
  logger.info(STELLAR_SECRET);
  assert.equal(entries[0].message, '[REDACTED]');
});

test('logger: secrets never appear in the serialised production JSON line', () => {
  const { logger, entries } = loadLogger({ nodeEnv: 'production' });
  logger.warn('payment', { token: 'tok_live_123', destination: { seed: STELLAR_SECRET } });

  const line = entries[0][MESSAGE];
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.token, '[REDACTED]');
  assert.equal(parsed.destination.seed, '[REDACTED]');
  assert.ok(!line.includes('tok_live_123'));
  assert.ok(!line.includes(STELLAR_SECRET));
});

test('logger: secrets never appear in the development pretty-printed line', () => {
  const { logger, entries } = loadLogger({ nodeEnv: 'development' });
  logger.info('auth', { authorization: 'Bearer leak-me' });
  const line = entries[0][MESSAGE];
  assert.ok(line.includes('[REDACTED]'));
  assert.ok(!line.includes('leak-me'));
});

test('logger: handles circular metadata without throwing', () => {
  const { logger, entries } = loadLogger();
  const meta = { name: 'loop' };
  meta.self = meta;
  assert.doesNotThrow(() => logger.info('circular', meta));
  assert.equal(entries[0].self.name, 'loop');
  assert.equal(entries[0].self.self, '[Circular]');
});

test('logger: attaches the active request id', () => {
  const { logger, entries } = loadLogger();
  runWithContext({ requestId: 'req-1234567890' }, () => logger.info('in request'));
  logger.info('outside request');
  assert.equal(entries[0].request_id, 'req-1234567890');
  assert.equal(entries[1].request_id, undefined);
});

test('logger: defaults to the info level', () => {
  const { logger, entries } = loadLogger();
  assert.equal(logger.level, 'info');
  logger.debug('hidden');
  logger.info('shown');
  assert.deepEqual(
    entries.map(e => e.message),
    ['shown']
  );
});

test('logger: LOG_LEVEL=debug enables debug output', () => {
  const { logger, entries } = loadLogger({ logLevel: 'debug' });
  assert.equal(logger.level, 'debug');
  logger.debug('visible');
  assert.equal(entries.length, 1);
});

test('logger: LOG_LEVEL=error suppresses lower levels', () => {
  const { logger, entries } = loadLogger({ logLevel: 'error' });
  logger.warn('nope');
  logger.info('nope');
  logger.error('yes');
  assert.deepEqual(
    entries.map(e => e[LEVEL]),
    ['error']
  );
});

test('logger: production uses structured JSON, development uses a text line', () => {
  const prod = loadLogger({ nodeEnv: 'production' });
  prod.logger.info('hello', { a: 1 });
  const parsed = JSON.parse(prod.entries[0][MESSAGE]);
  assert.equal(parsed.message, 'hello');
  assert.equal(parsed.a, 1);
  assert.ok(parsed.timestamp, 'timestamp is included');

  const dev = loadLogger({ nodeEnv: 'development' });
  dev.logger.info('hello', { a: 1 });
  const line = dev.entries[0][MESSAGE];
  assert.throws(() => JSON.parse(line));
  assert.match(line, /hello \{"a":1\}$/);
});
