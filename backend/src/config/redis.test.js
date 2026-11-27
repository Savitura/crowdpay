const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const proxyquire = require('proxyquire').noCallThru();

function recordingLogger() {
  const logs = [];
  return {
    logs,
    logger: {
      error: (message, meta) => logs.push({ level: 'error', message, meta }),
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
      debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
    },
  };
}

/** Loads redis.js against a fake ioredis constructor that records its arguments. */
function loadWithFakeRedis(redisUrl) {
  const saved = process.env.REDIS_URL;
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;

  const calls = [];
  class FakeRedis extends EventEmitter {
    constructor(url, options) {
      super();
      calls.push({ url, options });
    }
  }
  const { logs, logger } = recordingLogger();

  try {
    const redis = proxyquire('./redis', { ioredis: FakeRedis, './logger': logger });
    return { redis, calls, logs };
  } finally {
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  }
}

/** Returns a localhost port with nothing listening on it. */
async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('redis: defaults to localhost when REDIS_URL is unset', () => {
  const { calls } = loadWithFakeRedis(undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'redis://localhost:6379');
});

test('redis: uses REDIS_URL when provided (including TLS rediss:// URLs)', () => {
  const url = 'rediss://default:pw@cache.example.com:6380';
  const { calls } = loadWithFakeRedis(url);
  assert.equal(calls[0].url, url);
});

test('redis: connects lazily with bounded retries and a ready check', () => {
  const { calls } = loadWithFakeRedis('redis://localhost:6379');
  assert.deepEqual(calls[0].options, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
});

test('redis: connection errors are logged instead of crashing the process', () => {
  const { redis, logs } = loadWithFakeRedis('redis://localhost:6379');
  assert.equal(redis.listenerCount('error'), 1, 'an error listener prevents unhandled emits');
  assert.doesNotThrow(() => redis.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379')));
  assert.deepEqual(logs, [
    {
      level: 'error',
      message: 'Redis connection error',
      meta: { error: 'connect ECONNREFUSED 127.0.0.1:6379' },
    },
  ]);
});

test('redis: connect events are logged at info level', () => {
  const { redis, logs } = loadWithFakeRedis('redis://localhost:6379');
  redis.emit('connect');
  assert.deepEqual(logs, [{ level: 'info', message: 'Connected to Redis', meta: undefined }]);
});

test('redis: an unavailable server does not connect at load time and fails commands gracefully', async () => {
  const port = await closedPort();
  const saved = process.env.REDIS_URL;
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  const { logs, logger } = recordingLogger();

  let redis;
  try {
    // Real ioredis client, pointed at a port nobody is listening on.
    redis = proxyquire('./redis', { './logger': logger });
  } finally {
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  }

  try {
    assert.equal(redis.status, 'wait', 'lazyConnect: no socket is opened on require');
    assert.equal(logs.length, 0);

    await assert.rejects(() => redis.connect());
    assert.ok(
      logs.some(
        l =>
          l.level === 'error' &&
          l.message === 'Redis connection error' &&
          /ECONNREFUSED/.test(l.meta.error)
      ),
      'the refused connection is reported through the logger'
    );
  } finally {
    redis.disconnect();
  }
});
