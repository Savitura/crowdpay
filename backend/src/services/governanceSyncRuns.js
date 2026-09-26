'use strict';

/**
 * Governance synchronization run history and operator controls (#839).
 *
 * Every synchronization of on-chain proposal state into the database runs
 * through runGovernanceSync, which records exactly one governance_sync_runs
 * row per run — including failures — so operators can see when sync ran,
 * what it changed and why it failed without reading logs.
 *
 * Policies (see docs/governance-sync-runs.md):
 *  - Concurrency: at most one run is 'running' (unique partial index). A
 *    trigger that arrives while a run is in flight is deduplicated: it does
 *    not create a run and gets the in-flight run back instead.
 *  - Crash recovery: a run still 'running' after RUN_ABANDON_AFTER_MS is
 *    finalized as failed (ABANDONED) before the next run starts.
 *  - Retry: only a failed run is retryable; the retry is a new run linked by
 *    retry_of_run_id. A failed run has at most one retry, so repeating the
 *    retry request returns the same retry run (idempotent).
 *  - Immutability: a finished row never changes (enforced by a trigger).
 */

const db = require('../config/database');
const logger = require('../config/logger');
const { performProposalSync } = require('./governance');
const { logAuditEvent } = require('./auditService');

const RUN_STATUSES = ['running', 'succeeded', 'failed'];
const RUN_TRIGGERS = ['scheduled', 'manual', 'retry'];
const RUN_ABANDON_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 180;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const UNIQUE_VIOLATION = '23505';

const RUN_COLUMNS = `id, trigger, status, retry_of_run_id, requested_by, started_at, finished_at,
  proposals_seen, proposals_updated, proposals_missing, provider_cursor, error_code, error_message`;

let _schedulerTimer = null;

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/**
 * Error details persisted for operators: bounded, and scrubbed of anything
 * that looks like a Stellar secret seed or connection-string credentials.
 */
function safeErrorMessage(err) {
  const message = String((err && err.message) || err || 'unknown error')
    .replace(/\bS[A-Z2-7]{55}\b/g, '[redacted-secret]')
    .replace(/(\w+:\/\/)[^\s/@]+@/g, '$1[redacted]@');
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : message;
}

async function getRunningRun() {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM governance_sync_runs WHERE status = 'running' LIMIT 1`
  );
  return rows[0] || null;
}

/** Finalize runs left 'running' by a crashed or restarted process. */
async function recoverAbandonedRuns() {
  const { rows } = await db.query(
    `UPDATE governance_sync_runs
     SET status = 'failed', finished_at = NOW(), error_code = 'ABANDONED',
         error_message = 'Run did not finish (process crashed or restarted)'
     WHERE status = 'running'
       AND started_at < NOW() - ($1::int * INTERVAL '1 millisecond')
     RETURNING id`,
    [RUN_ABANDON_AFTER_MS]
  );
  if (rows.length) {
    logger.warn('governance-sync: finalized abandoned runs', { runIds: rows.map((r) => r.id) });
  }
  return rows.length;
}

/**
 * Insert the run row. Resolves to { run } or, when the insert loses to the
 * concurrency or retry uniqueness guard, to { conflict: 'running' | 'retry' }.
 */
async function insertRun({ trigger, requestedBy, retryOfRunId }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO governance_sync_runs (trigger, requested_by, retry_of_run_id)
       VALUES ($1, $2, $3)
       RETURNING ${RUN_COLUMNS}`,
      [trigger, requestedBy || null, retryOfRunId || null]
    );
    return { run: rows[0] };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    if (String(err.constraint || err.message).includes('retry_of')) return { conflict: 'retry' };
    return { conflict: 'running' };
  }
}

async function finishRun(runId, fields) {
  const { rows } = await db.query(
    `UPDATE governance_sync_runs
     SET status = $2, finished_at = NOW(),
         proposals_seen = $3, proposals_updated = $4, proposals_missing = $5,
         provider_cursor = $6, error_code = $7, error_message = $8
     WHERE id = $1 AND status = 'running'
     RETURNING ${RUN_COLUMNS}`,
    [
      runId,
      fields.status,
      fields.proposalsSeen || 0,
      fields.proposalsUpdated || 0,
      fields.proposalsMissing || 0,
      fields.providerCursor || null,
      fields.errorCode || null,
      fields.errorMessage || null,
    ]
  );
  return rows[0] || null;
}

async function auditTrigger({ run, requestedBy, req }) {
  if (run.trigger === 'scheduled') return;
  try {
    await logAuditEvent({
      actorId: requestedBy || null,
      action: run.trigger === 'retry' ? 'governance_sync_retried' : 'governance_sync_triggered',
      resourceType: 'governance_sync_run',
      resourceId: run.id,
      metadata: { trigger: run.trigger, retry_of_run_id: run.retry_of_run_id || null },
      req,
    });
  } catch (err) {
    logger.error('governance-sync: audit log failed', { runId: run.id, error: err.message });
  }
}

/**
 * Execute one synchronization run and record it.
 * @returns {Promise<{ run: object, deduplicated: boolean }>}
 */
async function runGovernanceSync({ trigger = 'manual', requestedBy = null, retryOfRunId = null, req = null } = {}) {
  if (!RUN_TRIGGERS.includes(trigger)) throw httpError(`Unknown trigger: ${trigger}`, 400);

  await recoverAbandonedRuns();

  const inserted = await insertRun({ trigger, requestedBy, retryOfRunId });
  if (inserted.conflict === 'retry') {
    const { rows } = await db.query(
      `SELECT ${RUN_COLUMNS} FROM governance_sync_runs WHERE retry_of_run_id = $1`,
      [retryOfRunId]
    );
    return { run: rows[0] || null, deduplicated: true };
  }
  if (inserted.conflict === 'running') {
    return { run: await getRunningRun(), deduplicated: true };
  }

  const { run } = inserted;
  await auditTrigger({ run, requestedBy, req });

  let finished;
  try {
    const result = await performProposalSync();
    finished = await finishRun(run.id, { status: 'succeeded', ...result });
  } catch (err) {
    const errorCode = err.code && /^[A-Z_]+$/.test(err.code) ? err.code : 'SYNC_ERROR';
    logger.error('governance-sync: run failed', { runId: run.id, errorCode, error: err.message });
    try {
      finished = await finishRun(run.id, {
        status: 'failed',
        errorCode,
        errorMessage: safeErrorMessage(err),
      });
    } catch (finishErr) {
      // The database itself is unavailable: the row stays 'running' and is
      // finalized as ABANDONED by the next run, so it is never lost.
      logger.error('governance-sync: could not record run failure', {
        runId: run.id,
        error: finishErr.message,
      });
      finished = { ...run, status: 'failed', error_code: errorCode, error_message: safeErrorMessage(err) };
    }
  }

  return { run: finished || run, deduplicated: false };
}

/** Retry a failed run by starting a new run linked to it (idempotent). */
async function retryRun(runId, { requestedBy = null, req = null } = {}) {
  const original = await getRun(runId);
  if (!original) throw httpError('Sync run not found', 404, 'SYNC_RUN_NOT_FOUND');
  if (original.status !== 'failed') {
    throw httpError('Only failed runs can be retried', 409, 'SYNC_RUN_NOT_RETRYABLE');
  }
  if (original.retries.length) {
    return { run: await getRun(original.retries[0].id), deduplicated: true };
  }
  return runGovernanceSync({ trigger: 'retry', requestedBy, retryOfRunId: runId, req });
}

function parseFilter(value, allowed, name) {
  if (value === undefined || value === null || value === '') return null;
  if (!allowed.includes(value)) {
    throw httpError(`${name} must be one of: ${allowed.join(', ')}`, 400, 'INVALID_FILTER');
  }
  return value;
}

/** Bounded, filterable page of runs, newest first. */
async function listRuns({ status, trigger, limit = 20, offset = 0 } = {}) {
  const statusFilter = parseFilter(status, RUN_STATUSES, 'status');
  const triggerFilter = parseFilter(trigger, RUN_TRIGGERS, 'trigger');

  const params = [];
  const clauses = [];
  if (statusFilter) {
    params.push(statusFilter);
    clauses.push(`status = $${params.length}`);
  }
  if (triggerFilter) {
    params.push(triggerFilter);
    clauses.push(`trigger = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM governance_sync_runs ${where}`,
    params
  );
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM governance_sync_runs ${where}
     ORDER BY started_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { data: rows, total: countRows[0]?.total || 0, limit, offset };
}

/** One run with the retries that point at it. */
async function getRun(runId) {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM governance_sync_runs WHERE id = $1`,
    [runId]
  );
  if (!rows.length) return null;
  const { rows: retries } = await db.query(
    `SELECT id, status, started_at, finished_at
     FROM governance_sync_runs WHERE retry_of_run_id = $1
     ORDER BY started_at`,
    [runId]
  );
  return { ...rows[0], retries };
}

/**
 * Retention: delete finished runs older than `retentionDays`. Runs are removed
 * leaf-first, and a run is kept while any retry pointing at it is still inside
 * the retention window, so retry links are never broken.
 * @returns {Promise<number>} rows deleted
 */
async function purgeExpiredRuns({
  retentionDays = Number(process.env.GOVERNANCE_SYNC_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
} = {}) {
  let deleted = 0;
  for (;;) {
    const { rows } = await db.query(
      `DELETE FROM governance_sync_runs r
       WHERE r.status <> 'running'
         AND r.finished_at < NOW() - ($1::int * INTERVAL '1 day')
         AND NOT EXISTS (SELECT 1 FROM governance_sync_runs c WHERE c.retry_of_run_id = r.id)
       RETURNING r.id`,
      [retentionDays]
    );
    deleted += rows.length;
    if (!rows.length) break;
  }
  if (deleted) logger.info('governance-sync: purged expired runs', { deleted, retentionDays });
  return deleted;
}

/**
 * Periodic scheduled runs. Not started automatically: the worker bootstrap
 * (#798) calls this when GOVERNANCE_SYNC_INTERVAL_MS is set.
 */
function startGovernanceSyncScheduler({
  intervalMs = Number(process.env.GOVERNANCE_SYNC_INTERVAL_MS) || DEFAULT_SCHEDULE_INTERVAL_MS,
} = {}) {
  if (_schedulerTimer) return _schedulerTimer;
  const tick = async () => {
    try {
      await runGovernanceSync({ trigger: 'scheduled' });
      await purgeExpiredRuns();
    } catch (err) {
      logger.error('governance-sync: scheduled run could not start', { error: err.message });
    }
  };
  _schedulerTimer = setInterval(tick, intervalMs);
  if (typeof _schedulerTimer.unref === 'function') _schedulerTimer.unref();
  logger.info('governance-sync: scheduler started', { interval_ms: intervalMs });
  return _schedulerTimer;
}

function stopGovernanceSyncScheduler() {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
    _schedulerTimer = null;
  }
}

module.exports = {
  RUN_STATUSES,
  RUN_TRIGGERS,
  RUN_ABANDON_AFTER_MS,
  runGovernanceSync,
  retryRun,
  listRuns,
  getRun,
  recoverAbandonedRuns,
  purgeExpiredRuns,
  safeErrorMessage,
  startGovernanceSyncScheduler,
  stopGovernanceSyncScheduler,
};
