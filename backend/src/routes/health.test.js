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
};

test('GET /health returns pool stats and ok status when database is reachable', async () => {
  const mockDb = {
    query: async (text) => {
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

  const app = proxyquire('../index', {
    './config/database': mockDb,
    './config/env': { validateEnv: () => {} },
    '@sentry/node': mockSentry,
    // Stub background services to prevent them from executing or failing
    './services/ledgerMonitor': {
      startLedgerMonitor: () => {},
      getLedgerStreamHealth: async () => ({ status: 'healthy' }),
    },
    './services/webhookDispatcher': {
      startWebhookRetryPoller: () => {},
    },
    './services/campaignStatusService': {
      refreshActiveCampaignStatuses: async () => {},
    },
    './services/alerting': {
      sendAlert: () => {},
    },
    './services/walletSecrets': {
      assertNoLegacyPlaintextUserWalletSecrets: async () => {},
    },
  });

  const response = await request(app).get('/health');
  
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'ok',
    db: {
      pool: { total: 8, idle: 5, waiting: 1, max: 10 },
      utilisation: 30,
    },
  });
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

  const app = proxyquire('../index', {
    './config/database': mockDb,
    './config/env': { validateEnv: () => {} },
    '@sentry/node': mockSentry,
    './services/ledgerMonitor': {
      startLedgerMonitor: () => {},
    },
    './services/webhookDispatcher': {
      startWebhookRetryPoller: () => {},
    },
    './services/campaignStatusService': {
      refreshActiveCampaignStatuses: async () => {},
    },
    './services/alerting': {
      sendAlert: () => {},
    },
    './services/walletSecrets': {
      assertNoLegacyPlaintextUserWalletSecrets: async () => {},
    },
  });

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

  const sentryWithScope = mockSentry.withScope || ((fn) => fn({ setLevel: () => {}, setTag: () => {}, setContext: () => {} }));
  const mockSentryCapture = {
    ...mockSentry,
    withScope: (fn) => {
      const scope = {
        setLevel: (l) => {},
        setTag: (k, v) => {},
        setContext: (k, v) => {},
      };
      fn(scope);
    },
    captureMessage: (msg) => {
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

  const app = proxyquire('../index', {
    './config/database': mockDb,
    './config/env': { validateEnv: () => {} },
    '@sentry/node': mockSentryCapture,
    './services/ledgerMonitor': {
      startLedgerMonitor: () => {},
      getLedgerStreamHealth: async () => ({ status: 'healthy' }),
    },
    './services/webhookDispatcher': {
      startWebhookRetryPoller: () => {},
    },
    './services/campaignStatusService': {
      refreshActiveCampaignStatuses: async () => {},
    },
    './services/alerting': {
      sendAlert: () => {},
    },
    './services/walletSecrets': {
      assertNoLegacyPlaintextUserWalletSecrets: async () => {},
    },
  });

  const response = await request(app).get('/health');
  
  assert.equal(response.status, 200);
  assert.equal(sentryMessages.length, 1);
  assert.match(sentryMessages[0], /Database pool utilisation exceeds 90%/i);
});
