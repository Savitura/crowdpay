const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function noop() {}
async function asyncNoop() {}

function buildWorker({ featureEnabled = () => true } = {}) {
  return proxyquire('./worker', {
    './config/logger': { info: noop, error: noop, warn: noop, debug: noop },
    './config/database': { query: async () => ({ rows: [] }) },
    './services/featureFlags': { isEnabled: featureEnabled },
    './services/ledgerMonitor': { startLedgerMonitor: asyncNoop },
    './services/webhookDispatcher': { startWebhookRetryPoller: noop },
    './services/recurringContributionsService': {
      startRecurringContributionsCron: noop,
      stopRecurringContributionsCron: noop,
    },
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
    './services/retentionPurge': { runAllPurges: asyncNoop },
    './services/restoreVerification': { runRestoreVerification: asyncNoop },
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

  await t.test('fails startup when every processor is disabled', async () => {
    const { startBackgroundWorkers } = buildWorker({ featureEnabled: () => false });
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    for (const name of [
      'ENABLE_LEDGER_MONITOR',
      'ENABLE_WEBHOOK_POLLER',
      'ENABLE_RECURRING_CONTRIBUTIONS_WORKER',
      'ENABLE_SUBSCRIPTION_CLAIM_WORKER',
      'ENABLE_HEALTH_COLLECTOR',
    ]) {
      process.env[name] = 'false';
    }

    await assert.rejects(startBackgroundWorkers(), /All background processors are disabled/);
  });

  await t.test('starts when at least one direct processor remains enabled', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker({
      featureEnabled: () => false,
    });
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_LEDGER_MONITOR = 'false';
    process.env.ENABLE_WEBHOOK_POLLER = 'false';
    process.env.ENABLE_RECURRING_CONTRIBUTIONS_WORKER = 'false';
    process.env.ENABLE_SUBSCRIPTION_CLAIM_WORKER = 'false';
    process.env.ENABLE_HEALTH_COLLECTOR = 'false';

    await assert.rejects(startBackgroundWorkers(), /All background processors are disabled/);
    process.env.ENABLE_WEBHOOK_POLLER = 'true';
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

  await t.test('gracefully drains in-flight tasks on stop', async () => {
    let resolveTask;
    const taskPromise = new Promise(resolve => {
      resolveTask = resolve;
    });

    const {
      stopBackgroundWorkers,
      trackTask,
      getInFlightCount,
    } = buildWorker();

    trackTask(taskPromise);
    assert.equal(getInFlightCount(), 1);

    let stopped = false;
    const stopPromise = stopBackgroundWorkers({ drainTimeoutMs: 1000 }).then(() => {
      stopped = true;
    });

    // Worker should still be waiting for task to drain
    assert.equal(stopped, false);
    assert.equal(getInFlightCount(), 1);

    // Complete the in-flight task
    resolveTask();
    await stopPromise;

    assert.equal(stopped, true);
    assert.equal(getInFlightCount(), 0);
  });

  await t.test('hands off active webhook and milestone leases on shutdown', async () => {
    const executedQueries = [];
    const fakeDb = {
      query: async (text, params) => {
        executedQueries.push({ text, params });
        return { rows: [] };
      },
    };

    const workerModule = proxyquire('./worker', {
      './config/logger': { info: noop, error: noop, warn: noop, debug: noop },
      './config/database': fakeDb,
      './services/featureFlags': { isEnabled: () => true },
      './services/ledgerMonitor': { startLedgerMonitor: asyncNoop },
      './services/webhookDispatcher': { startWebhookRetryPoller: noop },
      './services/recurringContributionsService': {
        startRecurringContributionsCron: noop,
        stopRecurringContributionsCron: noop,
      },
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
      './services/retentionPurge': { runAllPurges: asyncNoop },
      './services/restoreVerification': { runRestoreVerification: asyncNoop },
    });

    const {
      registerLease,
      handoffActiveLeases,
      getActiveLeaseCount,
    } = workerModule;

    registerLease('lease-token-1', { kind: 'user', deliveryId: 'del-1' });
    registerLease('lease-token-2', { kind: 'campaign', deliveryId: 'del-2' });
    registerLease('lease-token-3', { type: 'milestone_auto_release', attemptId: 'att-1' });

    assert.equal(getActiveLeaseCount(), 3);

    const handedOff = await handoffActiveLeases();
    assert.equal(handedOff, 3);
    assert.equal(getActiveLeaseCount(), 0);

    assert.equal(executedQueries.length, 3);
    assert.match(executedQueries[0].text, /UPDATE webhook_deliveries/);
    assert.deepEqual(executedQueries[0].params, ['del-1', 'lease-token-1']);

    assert.match(executedQueries[1].text, /UPDATE campaign_webhook_deliveries/);
    assert.deepEqual(executedQueries[1].params, ['del-2', 'lease-token-2']);

    assert.match(executedQueries[2].text, /UPDATE milestone_auto_release_attempts/);
    assert.deepEqual(executedQueries[2].params, ['att-1']);
  });

  await t.test('drain timeout failure edge case: proceeds when in-flight task stalls', async () => {
    // Unresolved task that hangs forever
    const stalledPromise = new Promise(() => {});

    const {
      stopBackgroundWorkers,
      trackTask,
      getInFlightCount,
    } = buildWorker();

    trackTask(stalledPromise);
    assert.equal(getInFlightCount(), 1);

    const start = Date.now();
    // Use short 50ms drain timeout
    await stopBackgroundWorkers({ drainTimeoutMs: 50 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 40, `Elapsed ${elapsed}ms should be around 50ms`);
  });
});
