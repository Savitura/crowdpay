const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const request = require('supertest');

const mockSentry = {
  init: () => {},
  expressIntegration: () => ({}),
  expressErrorHandler: () => (err, req, res, next) => next(err),
  Handlers: {
    requestHandler: () => (req, res, next) => next(),
    tracingHandler: () => (req, res, next) => next(),
    errorHandler: () => (err, req, res, next) => next(err),
  },
  captureMessage: () => {},
};

function buildApp(mockDb, mockSentryOverride = mockSentry, emailConfigured = true, options = {}) {
  return proxyquire('./health', {
    '../services/emailService': {
      isEmailConfigured: () => emailConfigured,
      verifyEmailTransport: options.verifyEmailTransport || (async () => ({ status: 'ok' })),
    },
    '../config/database': mockDb,
    '../config/redis': options.redis || { ping: async () => 'PONG' },
    '../config/env': { getMissingConfig: options.getMissingConfig || (() => []) },
    '../config/logger': { error: () => {} },
    '@sentry/node': mockSentryOverride,
  });
}

test('GET /health returns pool stats and ok status when database is reachable', async () => {
  const mockDb = {
    query: async text => {
      assert.equal(text, 'SELECT 1');
      return { rows: [] };
    },
    totalCount: 8,
    idleCount: 5,
    waitingCount: 1,
    poolMax: 10,
    getPoolMetrics: () => {
      const total = 8;
      const idle = 5;
      const waiting = 1;
      const max = 10;
      const utilisation = Math.round(((total - idle) / max) * 10000) / 100;
      return { total, idle, waiting, max, utilisation };
    },
  };

  const router = buildApp(mockDb);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'ok',
    db: {
      pool: { total: 8, idle: 5, waiting: 1, max: 10 },
      utilisation: 30,
    },
    email: 'ready',
  });
});

test('GET /health reports email: unconfigured when no transporter exists', async () => {
  const mockDb = {
    query: async () => ({ rows: [] }),
    getPoolMetrics: () => ({ total: 1, idle: 1, waiting: 0, max: 10, utilisation: 0 }),
  };
  const router = buildApp(mockDb, mockSentry, false);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.email, 'unconfigured');
});

test('GET /health returns 503 and error message when database query fails', async () => {
  const mockDb = {
    query: async () => {
      throw new Error('Connection refused');
    },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    poolMax: 10,
    getPoolMetrics: () => ({ total: 0, idle: 0, waiting: 0, max: 10, utilisation: 0 }),
  };

  const router = buildApp(mockDb);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: {
      code: 'ERROR',
      message: 'Connection refused',
    },
  });
});

test('GET /health sends Sentry alert when pool utilisation exceeds 90%', async () => {
  const sentryMessages = [];
  const mockSentryCapture = {
    ...mockSentry,
    captureMessage: msg => {
      sentryMessages.push(msg);
    },
  };

  const mockDb = {
    query: async () => ({ rows: [] }),
    totalCount: 10,
    idleCount: 0,
    waitingCount: 8,
    poolMax: 10,
    getPoolMetrics: () => {
      const total = 10;
      const idle = 0;
      const waiting = 8;
      const max = 10;
      const utilisation = Math.round(((total - idle) / max) * 10000) / 100;
      return { total, idle, waiting, max, utilisation };
    },
  };

  const router = buildApp(mockDb, mockSentryCapture);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.equal(sentryMessages.length, 1);
  assert.match(sentryMessages[0], /Database pool utilisation exceeds 90%/i);
});

test('GET /health/live is fast and does not touch dependencies', async () => {
  const mockDb = {
    query: async () => {
      throw new Error('liveness must not query the database');
    },
  };
  const router = buildApp(mockDb, mockSentry, true, {
    redis: {
      ping: async () => {
        throw new Error('liveness must not ping Redis');
      },
    },
  });
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health/live');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(typeof response.body.uptime_seconds, 'number');
});

test('GET /health/ready reports every dependency by name when healthy', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';

  try {
    const mockDb = { query: async () => ({ rows: [] }) };
    const router = buildApp(mockDb);
    const express = require('express');
    const app = express();
    app.use('/health', router);

    const response = await request(app).get('/health/ready');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.deepEqual(Object.keys(response.body.checks).sort(), [
      'config',
      'database',
      'horizon',
      'redis',
    ]);
    assert.equal(response.body.failed.length, 0);
  } finally {
    global.fetch = originalFetch;
    delete process.env.STELLAR_HORIZON_URL;
  }
});

test('GET /health/ready names failing dependencies without leaking messages', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.1');
  };
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';

  try {
    const mockDb = {
      query: async () => {
        throw new Error('password authentication failed for user secret');
      },
    };
    const router = buildApp(mockDb, mockSentry, true, {
      redis: { ping: async () => Promise.reject(new Error('NOAUTH secret')) },
      getMissingConfig: () => ['JWT_SECRET'],
    });
    const express = require('express');
    const app = express();
    app.use('/health', router);

    const response = await request(app).get('/health/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'degraded');
    assert.deepEqual(response.body.failed.sort(), ['config', 'database', 'horizon', 'redis']);
    assert.equal(response.body.checks.database.error, 'unavailable');
    assert.equal(response.body.checks.redis.error, 'unavailable');
    assert.equal(response.body.checks.horizon.error, 'unavailable');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
    assert.deepEqual(response.body.checks.config.missing, ['JWT_SECRET']);
  } finally {
    global.fetch = originalFetch;
    delete process.env.STELLAR_HORIZON_URL;
  }
});

test('GET /health/ready times out a hanging dependency', async () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
  global.fetch = () => new Promise(() => {});
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';
  process.env.HEALTH_CHECK_TIMEOUT_MS = '25';

  try {
    const mockDb = { query: async () => ({ rows: [] }) };
    const router = buildApp(mockDb);
    const express = require('express');
    const app = express();
    app.use('/health', router);

    const started = Date.now();
    const response = await request(app).get('/health/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.checks.horizon.error, 'timeout');
    assert.ok(Date.now() - started < 1000);
  } finally {
    global.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    else process.env.HEALTH_CHECK_TIMEOUT_MS = originalTimeout;
    delete process.env.STELLAR_HORIZON_URL;
  }
});

test('GET /health/ready/database returns 200 when reachable and 503 when down', async () => {
  const express = require('express');

  // Healthy DB
  const healthyRouter = buildApp({ query: async () => ({ rows: [] }) });
  const appHealthy = express();
  appHealthy.use('/health', healthyRouter);

  const resHealthy = await request(appHealthy).get('/health/ready/database');
  assert.equal(resHealthy.status, 200);
  assert.equal(resHealthy.headers['cache-control'], 'no-store');
  assert.equal(resHealthy.body.status, 'ok');
  assert.equal(resHealthy.body.service, 'database');
  assert.equal(resHealthy.body.database.status, 'ok');
  assert.equal(typeof resHealthy.body.database.latency_ms, 'number');

  // Alias /db works
  const resAlias = await request(appHealthy).get('/health/ready/db');
  assert.equal(resAlias.status, 200);
  assert.equal(resAlias.body.service, 'database');

  // Degraded DB
  const degradedRouter = buildApp({
    query: async () => {
      throw new Error('Connection refused');
    },
  });
  const appDegraded = express();
  appDegraded.use('/health', degradedRouter);

  const resDegraded = await request(appDegraded).get('/health/ready/database');
  assert.equal(resDegraded.status, 503);
  assert.equal(resDegraded.body.status, 'degraded');
  assert.equal(resDegraded.body.database.error, 'unavailable');
});

test('GET /health/ready/horizon returns 200 when ok, 503 when not configured, and 503 when down', async () => {
  const express = require('express');
  const mockDb = { query: async () => ({ rows: [] }) };
  const router = buildApp(mockDb);
  const app = express();
  app.use('/health', router);

  // 1. Not configured
  const resUnconfigured = await request(app).get('/health/ready/horizon');
  assert.equal(resUnconfigured.status, 503);
  assert.equal(resUnconfigured.body.status, 'degraded');
  assert.equal(resUnconfigured.body.horizon.error, 'not_configured');

  // 2. Healthy
  const originalFetch = global.fetch;
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';
  try {
    global.fetch = async () => ({ ok: true, status: 200 });
    const resHealthy = await request(app).get('/health/ready/horizon');
    assert.equal(resHealthy.status, 200);
    assert.equal(resHealthy.body.status, 'ok');
    assert.equal(resHealthy.body.service, 'horizon');
    assert.equal(resHealthy.body.horizon.http_status, 200);

    // 3. Degraded / network error
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const resDegraded = await request(app).get('/health/ready/horizon');
    assert.equal(resDegraded.status, 503);
    assert.equal(resDegraded.body.status, 'degraded');
    assert.equal(resDegraded.body.horizon.error, 'unavailable');
  } finally {
    global.fetch = originalFetch;
    delete process.env.STELLAR_HORIZON_URL;
  }
});

test('GET /health/ready/rpc returns 200 when reachable and 503 when not configured or failing', async () => {
  const express = require('express');
  const mockDb = { query: async () => ({ rows: [] }) };
  const router = buildApp(mockDb);
  const app = express();
  app.use('/health', router);

  // 1. Not configured
  const resUnconfigured = await request(app).get('/health/ready/rpc');
  assert.equal(resUnconfigured.status, 503);
  assert.equal(resUnconfigured.body.status, 'degraded');
  assert.equal(resUnconfigured.body.rpc.error, 'not_configured');

  const resSorobanAlias = await request(app).get('/health/ready/soroban');
  assert.equal(resSorobanAlias.status, 503);
  assert.equal(resSorobanAlias.body.service, 'rpc');

  // 2. Configured & healthy
  const originalFetch = global.fetch;
  process.env.SOROBAN_RPC_URL = 'https://rpc.example.test';
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
    });

    const resHealthy = await request(app).get('/health/ready/rpc');
    assert.equal(resHealthy.status, 200);
    assert.equal(resHealthy.body.status, 'ok');
    assert.equal(resHealthy.body.service, 'rpc');

    // 3. RPC error response
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid' } }),
    });

    const resError = await request(app).get('/health/ready/rpc');
    assert.equal(resError.status, 503);
    assert.equal(resError.body.rpc.error, 'rpc_error');
  } finally {
    global.fetch = originalFetch;
    delete process.env.SOROBAN_RPC_URL;
  }
});

test('GET /health/ready/email checks email provider readiness', async () => {
  const express = require('express');
  const mockDb = { query: async () => ({ rows: [] }) };

  // 1. Configured & healthy
  const appHealthy = express();
  appHealthy.use(
    '/health',
    buildApp(mockDb, mockSentry, true, {
      verifyEmailTransport: async () => ({ status: 'ok' }),
    })
  );
  const resHealthy = await request(appHealthy).get('/health/ready/email');
  assert.equal(resHealthy.status, 200);
  assert.equal(resHealthy.body.status, 'ok');
  assert.equal(resHealthy.body.service, 'email');
  assert.equal(resHealthy.body.email.status, 'ok');

  // Aliases /smtp and /mail
  const resSmtp = await request(appHealthy).get('/health/ready/smtp');
  assert.equal(resSmtp.status, 200);
  assert.equal(resSmtp.body.service, 'email');

  // 2. Unconfigured
  const appUnconfigured = express();
  appUnconfigured.use('/health', buildApp(mockDb, mockSentry, false));
  const resUnconfigured = await request(appUnconfigured).get('/health/ready/email');
  assert.equal(resUnconfigured.status, 503);
  assert.equal(resUnconfigured.body.status, 'degraded');
  assert.equal(resUnconfigured.body.email.error, 'not_configured');

  // 3. Verification failure (e.g. SMTP connection/auth refused)
  const appFailing = express();
  appFailing.use(
    '/health',
    buildApp(mockDb, mockSentry, true, {
      verifyEmailTransport: async () => {
        throw new Error('SMTP connection refused');
      },
    })
  );
  const resFailing = await request(appFailing).get('/health/ready/email');
  assert.equal(resFailing.status, 503);
  assert.equal(resFailing.body.status, 'degraded');
  assert.equal(resFailing.body.email.error, 'unavailable');

  // 4. Verification timeout
  const appTimeout = express();
  const originalTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
  process.env.HEALTH_CHECK_TIMEOUT_MS = '20';
  appTimeout.use(
    '/health',
    buildApp(mockDb, mockSentry, true, {
      verifyEmailTransport: () => new Promise(() => {}),
    })
  );
  try {
    const resTimeout = await request(appTimeout).get('/health/ready/email');
    assert.equal(resTimeout.status, 503);
    assert.equal(resTimeout.body.email.error, 'timeout');
  } finally {
    if (originalTimeout === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    else process.env.HEALTH_CHECK_TIMEOUT_MS = originalTimeout;
  }

  // 5. Disabled emails via DISABLE_EMAILS=true
  process.env.DISABLE_EMAILS = 'true';
  try {
    const appDisabled = express();
    appDisabled.use('/health', buildApp(mockDb, mockSentry, false));
    const resDisabled = await request(appDisabled).get('/health/ready/email');
    assert.equal(resDisabled.status, 200);
    assert.equal(resDisabled.body.status, 'ok');
    assert.equal(resDisabled.body.email.disabled, true);
  } finally {
    delete process.env.DISABLE_EMAILS;
  }
});

test('GET /health/ready/:service returns 404 for unknown checks', async () => {
  const express = require('express');
  const mockDb = { query: async () => ({ rows: [] }) };
  const router = buildApp(mockDb);
  const app = express();
  app.use('/health', router);

  const res = await request(app).get('/health/ready/unknown_subsystem');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'unknown_check');
  assert.ok(Array.isArray(res.body.valid_checks));
  assert.ok(res.body.valid_checks.includes('database'));
  assert.ok(res.body.valid_checks.includes('horizon'));
  assert.ok(res.body.valid_checks.includes('rpc'));
  assert.ok(res.body.valid_checks.includes('email'));
});

test('GET /health/ready supports query filtering (?check=database,email)', async () => {
  const express = require('express');
  const mockDb = { query: async () => ({ rows: [] }) };
  const router = buildApp(mockDb, mockSentry, true, {
    verifyEmailTransport: async () => ({ status: 'ok' }),
  });
  const app = express();
  app.use('/health', router);

  const resFiltered = await request(app).get('/health/ready?check=database,email');
  assert.equal(resFiltered.status, 200);
  assert.deepEqual(Object.keys(resFiltered.body.checks).sort(), ['database', 'email']);
  assert.equal(resFiltered.body.checks.database.status, 'ok');
  assert.equal(resFiltered.body.checks.email.status, 'ok');

  // Invalid filter returns 400
  const resInvalid = await request(app).get('/health/ready?check=invalid_one,invalid_two');
  assert.equal(resInvalid.status, 400);
  assert.equal(resInvalid.body.error, 'invalid_filter');
});
