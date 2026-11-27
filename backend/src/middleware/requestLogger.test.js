const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const SECRETS = {
  embedToken: 'cped_0123456789abcdef',
  token: 'session-token-value',
  password: 'hunter2',
  authorization: 'Bearer super-secret-jwt',
  apiKey: 'cpk_live_apikeyvalue',
  cookie: 'crowdpay_session=cookie-value',
};

function loadRequestLogger(requestId = 'req-abc') {
  const entries = [];
  const logger = {
    info: (...args) => entries.push({ level: 'info', args }),
    warn: (...args) => entries.push({ level: 'warn', args }),
    error: (...args) => entries.push({ level: 'error', args }),
  };
  const { requestLogger } = proxyquire('./requestLogger', {
    '../config/logger': logger,
    '../config/requestContext': { getRequestContext: () => ({ requestId }) },
  });
  return { requestLogger, entries };
}

function mockRes(statusCode = 200) {
  const listeners = {};
  return {
    statusCode,
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
    emit(event) {
      listeners[event]?.();
    },
  };
}

function request(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: '/api/campaigns',
    headers: {},
    ...overrides,
  };
}

test('requestLogger logs method, path, status, duration and requestId on finish', () => {
  const { requestLogger, entries } = loadRequestLogger('req-123');
  const req = request();
  const res = mockRes(200);
  let nextCalled = false;

  requestLogger(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'the middleware must not block the chain');
  assert.equal(entries.length, 0, 'nothing is logged before the response finishes');

  res.emit('finish');

  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.level, 'info');
  const [message, meta] = entry.args;
  assert.equal(message, 'request');
  assert.equal(meta.method, 'GET');
  assert.equal(meta.path, '/api/campaigns');
  assert.equal(meta.status, 200);
  assert.equal(meta.requestId, 'req-123');
  assert.equal(typeof meta.duration_ms, 'number');
  assert.ok(meta.duration_ms >= 0);
});

test('requestLogger strips the query string from the logged path', () => {
  const { requestLogger, entries } = loadRequestLogger();
  const req = request({
    originalUrl: `/api/embed/discover?embedToken=${SECRETS.embedToken}&page=2`,
  });
  const res = mockRes(200);

  requestLogger(req, res, () => {});
  res.emit('finish');

  assert.equal(entries[0].args[1].path, '/api/embed/discover');
});

test('requestLogger never writes sensitive query params, headers or cookies to the log', () => {
  const { requestLogger, entries } = loadRequestLogger();
  const req = request({
    method: 'POST',
    originalUrl: `/api/auth/login?embedToken=${SECRETS.embedToken}&token=${SECRETS.token}&password=${SECRETS.password}&redirect=%2Fdashboard`,
    headers: {
      authorization: SECRETS.authorization,
      'x-api-key': SECRETS.apiKey,
      cookie: SECRETS.cookie,
    },
  });
  const res = mockRes(201);

  requestLogger(req, res, () => {});
  res.emit('finish');

  const logged = JSON.stringify(entries[0].args);
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.equal(logged.includes(value), false, `${name} leaked into the log entry`);
  }
  assert.equal(entries[0].args[1].path, '/api/auth/login');
});

test('requestLogger uses warn for client errors and error for server errors', () => {
  const { requestLogger, entries } = loadRequestLogger();

  for (const status of [400, 404, 429]) {
    const res = mockRes(status);
    requestLogger(request(), res, () => {});
    res.emit('finish');
  }
  for (const status of [500, 503]) {
    const res = mockRes(status);
    requestLogger(request(), res, () => {});
    res.emit('finish');
  }

  assert.deepEqual(
    entries.map(entry => entry.level),
    ['warn', 'warn', 'warn', 'error', 'error']
  );
});

test('requestLogger falls back to the request url when originalUrl is absent', () => {
  const { requestLogger, entries } = loadRequestLogger();
  const req = { method: 'GET', url: '/health/live?verbose=1', headers: {} };
  const res = mockRes(200);

  requestLogger(req, res, () => {});
  res.emit('finish');

  assert.equal(entries[0].args[1].path, '/health/live');
});
