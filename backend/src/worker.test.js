const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function noop() {}
async function asyncNoop() {}

function buildWorker({ lockAcquired = true } = {}) {
  return proxyquire('./worker', {
    './config/logger': { info: noop, error: noop, warn: noop, debug: noop },
    './config/database': {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [{ locked: lockAcquired }] }),
        release: noop,
      }),
    },
    './services/featureFlags': { isEnabled: () => true },
    './services/ledgerMonitor': { startLedgerMonitor: asyncNoop },
    './services/webhookDispatcher': { startWebhookRetryPoller: noop },
    './services/recurring': {
      startSubscriptionClaimWorker: noop,
      stopSubscriptionClaimWorker: noop,
    },
    './services/ops/healthCollector': {
      startHealthCollector: noop,
      stopHealthCollector: noop,
    },
    './services/campaignStatusService': { refreshActiveCampaignStatuses: asyncNoop },
    './services/reconciliation': { reconcileCampaignBalances: asyncNoop },
    './services/campaignPublishing': { publishDraftCampaign: asyncNoop },
    './services/contractDeploymentRetryService': { retryFailedContractDeployments: asyncNoop },
    './services/weeklyDigestService': { sendWeeklyContributorDigests: asyncNoop },
    './services/deadlineReminderService': { sendDeadlineReminders: asyncNoop },
    './services/campaignUpdatesPublishing': { publishDueCampaignUpdates: asyncNoop },
    './services/payoutScheduleService': { processDuePayoutSchedules: asyncNoop },
    './services/milestoneAutoRelease': { processAutoReleases: asyncNoop },
  });
}

test('Background Worker Bootstrap', async t => {
  let originalEnv;

  t.beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  t.afterEach(() => {
    process.env = originalEnv;
  });

  await t.test('does not start in test environment', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.NODE_ENV = 'test';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('does not start when WORKER_ENABLED is false', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.WORKER_ENABLED = 'false';
    process.env.NODE_ENV = 'development';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('starts workers when enabled', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';

    await startBackgroundWorkers();

    assert.equal(isWorkerRunning(), true);

    await stopBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
  });

  await t.test('skips an interval tick while the previous run is in flight', async () => {
    const { startInterval, stopBackgroundWorkers } = buildWorker();
    let releaseRun;
    let calls = 0;
    const running = new Promise(resolve => {
      releaseRun = resolve;
    });

    startInterval(
      'overlap-test',
      async () => {
        calls += 1;
        await running;
      },
      5
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls, 1);

    releaseRun();
    await stopBackgroundWorkers();
  });

  await t.test('skips a scheduled job when another worker holds its advisory lock', async () => {
    const { startInterval, stopBackgroundWorkers } = buildWorker({ lockAcquired: false });
    let calls = 0;

    startInterval(
      'locked-test',
      async () => {
        calls += 1;
      },
      60_000
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);

    await stopBackgroundWorkers();
  });
});
