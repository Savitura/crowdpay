const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const sentryStub = {
  init: () => {},
  expressIntegration: () => ({}),
  expressErrorHandler: () => (err, _req, _res, next) => next(err),
  Handlers: {
    requestHandler: () => (_req, _res, next) => next(),
    tracingHandler: () => (_req, _res, next) => next(),
    errorHandler: () => (err, _req, _res, next) => next(err),
  },
  captureMessage: () => {},
};

function buildApp({
  db = { query: async () => ({ rows: [] }) },
  redis = { ping: async () => 'PONG' },
  verifyEmailTransport = async () => ({ status: 'ok' }),
  missingConfig = [],
} = {}) {
  const router = proxyquire('./health', {
    '../config/database': db,
    '../config/redis': redis,
    '../services/emailService': {
      isEmailConfigured: () => true,
      verifyEmailTransport,
    },
    '../config/env': { getMissingConfig: () => missingConfig },
    '../config/logger': { error: () => {} },
    '@sentry/node': sentryStub,
  });

  const app = express();
  app.use('/health', router);
  return app;
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

test('GET /health/ready/horizon reports degraded HTTP responses without leaking upstream bodies', async () => {
  const restoreFetch = global.fetch;
  const restoreEnv = saveEnv(['STELLAR_HORIZON_URL']);
  const requested = [];

  global.fetch = async url => {
    requested.push(url);
    return { ok: false, status: 503, text: async () => 'upstream secret token' };
  };
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test/';

  try {
    const res = await request(buildApp()).get('/health/ready/horizon');

    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.service, 'horizon');
    assert.equal(res.body.horizon.status, 'error');
    assert.equal(res.body.horizon.error, 'http_error');
    assert.equal(res.body.horizon.http_status, 503);
    assert.deepEqual(requested, ['https://horizon.example.test/fee_stats']);
    assert.equal(JSON.stringify(res.body).includes('secret'), false);
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    global.fetch = restoreFetch;
    restoreEnv();
  }
});

test('GET /health/ready/rpc reports degraded HTTP responses from the legacy RPC env var', async () => {
  const restoreFetch = global.fetch;
  const restoreEnv = saveEnv(['SOROBAN_RPC_URL', 'STELLAR_SOROBAN_RPC_URL']);
  let fetchCall = null;

  global.fetch = async (url, init) => {
    fetchCall = { url, init };
    return { ok: false, status: 502 };
  };
  delete process.env.SOROBAN_RPC_URL;
  process.env.STELLAR_SOROBAN_RPC_URL = 'https://rpc.example.test';

  try {
    const res = await request(buildApp()).get('/health/ready/soroban');

    assert.equal(res.status, 503);
    assert.equal(res.body.service, 'rpc');
    assert.equal(res.body.rpc.error, 'http_error');
    assert.equal(res.body.rpc.http_status, 502);
    assert.equal(fetchCall.url, 'https://rpc.example.test');
    assert.equal(fetchCall.init.method, 'POST');
    assert.equal(JSON.parse(fetchCall.init.body).method, 'getHealth');
  } finally {
    global.fetch = restoreFetch;
    restoreEnv();
  }
});

test('GET /health/ready/database distinguishes a timeout from an unavailable database', async () => {
  const restoreEnv = saveEnv(['HEALTH_CHECK_TIMEOUT_MS']);
  process.env.HEALTH_CHECK_TIMEOUT_MS = '20';

  try {
    const hanging = await request(buildApp({ db: { query: () => new Promise(() => {}) } })).get(
      '/health/ready/database'
    );

    assert.equal(hanging.status, 503);
    assert.equal(hanging.body.database.error, 'timeout');
    assert.equal(hanging.body.database.status, 'error');

    const refused = await request(
      buildApp({
        db: {
          query: async () => {
            throw new Error('password authentication failed for user secret');
          },
        },
      })
    ).get('/health/ready/database');

    assert.equal(refused.status, 503);
    assert.equal(refused.body.database.error, 'unavailable');
    assert.equal(JSON.stringify(refused.body).includes('secret'), false);
  } finally {
    restoreEnv();
  }
});

test('GET /health/ready names every degraded dependency in a filtered request', async () => {
  const restoreFetch = global.fetch;
  const restoreEnv = saveEnv(['STELLAR_HORIZON_URL', 'SOROBAN_RPC_URL']);
  global.fetch = async url =>
    url.includes('fee_stats')
      ? { ok: false, status: 500 }
      : { ok: true, status: 200, json: async () => ({ error: { code: -32600 } }) };
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';
  process.env.SOROBAN_RPC_URL = 'https://rpc.example.test';

  try {
    const app = buildApp({
      db: {
        query: async () => {
          throw new Error('dsn=postgres://user:secret@db');
        },
      },
      redis: {
        ping: async () => {
          throw new Error('NOAUTH secret');
        },
      },
      missingConfig: ['JWT_SECRET'],
    });

    const res = await request(app).get('/health/ready?check=database,redis,horizon,rpc,config');

    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.deepEqual(res.body.failed.slice().sort(), [
      'config',
      'database',
      'horizon',
      'redis',
      'rpc',
    ]);
    assert.equal(res.body.checks.database.error, 'unavailable');
    assert.equal(res.body.checks.redis.error, 'unavailable');
    assert.equal(res.body.checks.horizon.error, 'http_error');
    assert.equal(res.body.checks.rpc.error, 'rpc_error');
    assert.deepEqual(res.body.checks.config.missing, ['JWT_SECRET']);
    assert.equal(JSON.stringify(res.body).includes('secret'), false);
  } finally {
    global.fetch = restoreFetch;
    restoreEnv();
  }
});
