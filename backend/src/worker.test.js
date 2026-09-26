const assert = require('assert').strict;
const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = require('./worker');
const featureFlags = require('./services/featureFlags');

// Mock external dependencies
jest.mock('./services/ledgerMonitor', () => ({
  startLedgerMonitor: jest.fn(),
}));
jest.mock('./services/webhookDispatcher', () => ({
  startWebhookRetryPoller: jest.fn(),
}));
jest.mock('./services/recurringContributionsService', () => ({
  startRecurringContributionsCron: jest.fn(),
  stopRecurringContributionsCron: jest.fn(),
}));
jest.mock('./services/recurring', () => ({
  startSubscriptionClaimWorker: jest.fn(),
  stopSubscriptionClaimWorker: jest.fn(),
}));
jest.mock('./services/ops/healthCollector', () => ({
  startHealthCollector: jest.fn(),
  stopHealthCollector: jest.fn(),
}));
jest.mock('./services/featureFlags', () => ({
  isEnabled: jest.fn(() => true),
}));

describe('Background Worker Bootstrap', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    await stopBackgroundWorkers();
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('does not start in test environment', async () => {
    process.env.NODE_ENV = 'test';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
  });

  it('does not start when WORKER_ENABLED is false', async () => {
    process.env.WORKER_ENABLED = 'false';
    process.env.NODE_ENV = 'development';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
  });

  it('starts workers when enabled', async () => {
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    
    await startBackgroundWorkers();
    
    assert.equal(isWorkerRunning(), true);
    
    await stopBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
  });
});
