const logger = require('./config/logger');
const db = require('./config/database');
const { validateEnv } = require('./config/env');
const featureFlags = require('./services/featureFlags');

// Imported workers that have their own start/stop functions
const { startLedgerMonitor } = require('./services/ledgerMonitor');
const { startWebhookRetryPoller } = require('./services/webhookDispatcher');
const {
  startSubscriptionClaimWorker,
  stopSubscriptionClaimWorker,
} = require('./services/recurring');
const { startHealthCollector, stopHealthCollector } = require('./services/ops/healthCollector');

// Imported services that need scheduled wrappers
const { refreshActiveCampaignStatuses } = require('./services/campaignStatusService');
const { reconcileCampaignBalances } = require('./services/reconciliation');
const { publishDraftCampaign } = require('./services/campaignPublishing');
const { retryFailedContractDeployments } = require('./services/contractDeploymentRetryService');
const { sendWeeklyContributorDigests } = require('./services/weeklyDigestService');
const { sendDeadlineReminders } = require('./services/deadlineReminderService');
const { publishDueCampaignUpdates } = require('./services/campaignUpdatesPublishing');
const { processDuePayoutSchedules } = require('./services/payoutScheduleService');
const { processAutoReleases } = require('./services/milestoneAutoRelease');

let intervals = [];
let isShuttingDown = false;

async function runWithAdvisoryLock(name, fn) {
  const client = await db.connect();
  let lockAcquired = false;
  let releaseError;
  const lockName = `crowdpay:worker:${name}`;

  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [lockName]
    );
    lockAcquired = rows[0]?.locked === true;
    if (!lockAcquired) {
      logger.info(`worker: ${name} skipped (another instance holds the advisory lock)`);
      return;
    }
    await fn();
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      } catch (err) {
        releaseError = err;
        logger.error(`worker: ${name} advisory unlock failed`, { error: err.message });
      }
    }
    client.release(releaseError);
  }
}

async function runScheduledPublishing() {
  if (isShuttingDown) return;
  try {
    const { rows } = await db.query(
      `SELECT id FROM campaigns WHERE status = 'draft' AND scheduled_publish_at <= NOW()`
    );
    for (const { id } of rows) {
      if (isShuttingDown) break;
      try {
        await publishDraftCampaign(id);
      } catch (err) {
        logger.error('worker: Scheduled publish failed', { campaignId: id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('worker: Scheduled publish query failed', { error: err.message });
  }
}

function startInterval(name, fn, intervalMs, featureFlagKey = null) {
  if (featureFlagKey && !featureFlags.isEnabled(featureFlagKey)) {
    logger.info(`worker: skipped ${name} (feature flag ${featureFlagKey} disabled)`);
    return;
  }

  logger.info(`worker: starting ${name} (interval ${intervalMs}ms)`);

  let inFlight = false;
  const run = async () => {
    if (isShuttingDown || inFlight) return;
    inFlight = true;
    try {
      await runWithAdvisoryLock(name, fn);
    } catch (err) {
      logger.error(`worker: ${name} failed`, { error: err.message });
    } finally {
      inFlight = false;
    }
  };

  run();
  const timer = setInterval(run, intervalMs);

  intervals.push(timer);
}

async function startBackgroundWorkers() {
  if (process.env.WORKER_ENABLED === 'false' || process.env.NODE_ENV === 'test') {
    logger.info('worker: disabled via configuration or test environment');
    return;
  }

  isShuttingDown = false;
  logger.info('worker: bootstrapping background lifecycle');

  // Ledger monitoring (has own start/stop logic and intervals, usually doesn't need feature flag check here as it checks it internally if needed, but we start it anyway)
  if (process.env.ENABLE_LEDGER_MONITOR !== 'false') {
    try {
      await startLedgerMonitor();
    } catch (err) {
      logger.error('worker: ledger monitor failed to start', { error: err.message });
    }
  }

  // Webhooks
  if (process.env.ENABLE_WEBHOOK_POLLER !== 'false') {
    startWebhookRetryPoller();
  }

  // Recurring subscription installments are claimed by the subscription worker.
  startSubscriptionClaimWorker();

  // Health collector
  if (process.env.ENABLE_HEALTH_COLLECTOR !== 'false') {
    startHealthCollector();
  }

  // Wrapped workers (checking specific feature flags)
  // Campaign status: Hourly
  startInterval(
    'campaign-status-cron',
    refreshActiveCampaignStatuses,
    60 * 60 * 1000,
    'campaign-status-cron'
  );

  // Reconciliation: 15 minutes
  startInterval(
    'reconciliation-cron',
    reconcileCampaignBalances,
    15 * 60 * 1000,
    'reconciliation-cron'
  );

  // Scheduled publishing: 5 minutes
  startInterval(
    'scheduled-publish-cron',
    runScheduledPublishing,
    5 * 60 * 1000,
    'scheduled-publish-cron'
  );

  // Contract deployment retry: 15 minutes
  startInterval(
    'contract-deployment-retry-cron',
    retryFailedContractDeployments,
    15 * 60 * 1000,
    'contract-deployment-retry-cron'
  );

  // Weekly digests: 1 hour (evaluates if digest is needed internally)
  startInterval(
    'weekly-digest-cron',
    sendWeeklyContributorDigests,
    60 * 60 * 1000,
    'weekly-digest-cron'
  );

  // Deadline reminders: 1 hour
  startInterval(
    'deadline-reminder-cron',
    sendDeadlineReminders,
    60 * 60 * 1000,
    'deadline-reminder-cron'
  );

  // Scheduled campaign updates: 1 minute
  startInterval(
    'scheduled-campaign-updates-cron',
    publishDueCampaignUpdates,
    60 * 1000,
    'scheduled-campaign-updates-cron'
  );

  // Recurring payout schedules: 5 minutes
  startInterval(
    'recurring-payout-schedules-cron',
    processDuePayoutSchedules,
    5 * 60 * 1000,
    'recurring-payout-schedules-cron'
  );

  // Automatic milestone releases: 1 minute. Schedules live in the database and
  // the first run happens at startup, so a restart never misses a window.
  startInterval(
    'milestone-auto-release-cron',
    () => processAutoReleases(),
    60 * 1000,
    'milestone-auto-release-cron'
  );
}

async function stopBackgroundWorkers() {
  logger.info('worker: stopping background lifecycle');
  isShuttingDown = true;

  // Clear managed intervals
  for (const timer of intervals) {
    clearInterval(timer);
  }
  intervals = [];

  // Call exposed stop functions
  try {
    if (typeof stopSubscriptionClaimWorker === 'function') stopSubscriptionClaimWorker();
    if (typeof stopHealthCollector === 'function') stopHealthCollector();
    // (Ledger monitor and webhook poller might need stop functions if they exist, but we do best-effort)
  } catch (err) {
    logger.error('worker: error stopping sub-workers', { error: err.message });
  }
}

function isWorkerRunning() {
  return !isShuttingDown && intervals.length > 0;
}

module.exports = {
  startBackgroundWorkers,
  stopBackgroundWorkers,
  isWorkerRunning,
  startInterval,
};

if (require.main === module) {
  if (process.env.NODE_ENV !== 'test') validateEnv();
  startBackgroundWorkers().catch(err => {
    logger.error('worker: failed to start', { error: err.message });
    process.exitCode = 1;
  });

  const gracefulShutdown = async () => {
    await stopBackgroundWorkers();
    process.exit(0);
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}
