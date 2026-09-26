'use strict';

// Governance sync run history (#839). The service runs against an in-memory
// governance_sync_runs table that enforces the migration's rules (one running
// run, one retry per failed run, finished rows immutable); the SQL itself is
// checked against Postgres in governanceSyncRuns.pg.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function uniqueViolation(constraint) {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  err.code = '23505';
  err.constraint = constraint;
  return err;
}

function createRunsTable() {
  const runs = [];
  let clock = Date.parse('2026-09-26T10:00:00Z');
  const now = () => new Date(clock);
  let failNextFinish = false;

  async function query(text, params = []) {
    await new Promise((resolve) => setImmediate(resolve));

    if (/error_code = 'ABANDONED'/.test(text)) {
      const cutoff = clock - params[0];
      const abandoned = runs.filter((r) => r.status === 'running' && r.started_at.getTime() < cutoff);
      for (const r of abandoned) {
        Object.assign(r, { status: 'failed', finished_at: now(), error_code: 'ABANDONED', error_message: 'Run did not finish (process crashed or restarted)' });
      }
      return { rows: abandoned.map((r) => ({ id: r.id })) };
    }

    if (/INSERT INTO governance_sync_runs/.test(text)) {
      const [trigger, requestedBy, retryOf] = params;
      if (retryOf && runs.some((r) => r.retry_of_run_id === retryOf)) {
        throw uniqueViolation('governance_sync_runs_retry_of_idx');
      }
      if (runs.some((r) => r.status === 'running')) {
        throw uniqueViolation('governance_sync_runs_one_running_idx');
      }
      const run = {
        id: crypto.randomUUID(),
        trigger,
        status: 'running',
        retry_of_run_id: retryOf,
        requested_by: requestedBy,
        started_at: now(),
        finished_at: null,
        proposals_seen: 0,
        proposals_updated: 0,
        proposals_missing: 0,
        provider_cursor: null,
        error_code: null,
        error_message: null,
      };
      runs.push(run);
      return { rows: [{ ...run }] };
    }

    if (/UPDATE governance_sync_runs\s+SET status = \$2/.test(text)) {
      if (failNextFinish) {
        failNextFinish = false;
        throw new Error('connection terminated unexpectedly');
      }
      const run = runs.find((r) => r.id === params[0] && r.status === 'running');
      if (!run) return { rows: [] };
      const [, status, seen, updated, missing, cursor, code, message] = params;
      Object.assign(run, {
        status,
        finished_at: now(),
        proposals_seen: seen,
        proposals_updated: updated,
        proposals_missing: missing,
        provider_cursor: cursor,
        error_code: code,
        error_message: message,
      });
      return { rows: [{ ...run }] };
    }

    if (/WHERE status = 'running' LIMIT 1/.test(text)) {
      return { rows: runs.filter((r) => r.status === 'running').map((r) => ({ ...r })) };
    }

    if (/SELECT id, status, started_at, finished_at\s+FROM governance_sync_runs WHERE retry_of_run_id = \$1/.test(text)) {
      return { rows: runs.filter((r) => r.retry_of_run_id === params[0]).map((r) => ({ ...r })) };
    }

    if (/FROM governance_sync_runs WHERE retry_of_run_id = \$1/.test(text)) {
      return { rows: runs.filter((r) => r.retry_of_run_id === params[0]).map((r) => ({ ...r })) };
    }

    if (/FROM governance_sync_runs WHERE id = \$1/.test(text)) {
      return { rows: runs.filter((r) => r.id === params[0]).map((r) => ({ ...r })) };
    }

    return { rows: [] };
  }

  return {
    query,
    runs,
    advance: (ms) => { clock += ms; },
    failNextFinish: () => { failNextFinish = true; },
  };
}

function buildService({ table = createRunsTable(), performProposalSync, queryOverride } = {}) {
  const audits = [];
  const service = proxyquire('./governanceSyncRuns', {
    '../config/database': { query: queryOverride || table.query },
    '../config/logger': silentLogger,
    './governance': {
      performProposalSync:
        performProposalSync ||
        (async () => ({ proposalsSeen: 1, proposalsUpdated: 1, proposalsMissing: 0, providerCursor: 'proposal:7' })),
    },
    './auditService': {
      logAuditEvent: async (event) => {
        audits.push(event);
      },
    },
  });
  return { service, table, audits };
}

function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test('a successful run records exactly one immutable history row with counts and cursor', async () => {
  const { service, table, audits } = buildService();

  const { run, deduplicated } = await service.runGovernanceSync({ trigger: 'manual', requestedBy: 'admin-1' });

  assert.equal(deduplicated, false);
  assert.equal(table.runs.length, 1);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.requested_by, 'admin-1');
  assert.equal(run.proposals_seen, 1);
  assert.equal(run.proposals_updated, 1);
  assert.equal(run.provider_cursor, 'proposal:7');
  assert.ok(run.finished_at);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'governance_sync_triggered');
  assert.equal(audits[0].resourceId, run.id);
});

test('a scheduled run is recorded but not audited as an operator action', async () => {
  const { service, table, audits } = buildService();
  const { run } = await service.runGovernanceSync({ trigger: 'scheduled' });
  assert.equal(run.trigger, 'scheduled');
  assert.equal(table.runs.length, 1);
  assert.equal(audits.length, 0);
});

test('a provider failure is recorded as a failed run with a safe error summary', async () => {
  const { service, table } = buildService({
    performProposalSync: async () => {
      throw taggedError('PROVIDER_ERROR', 'soroban rpc timeout; signer SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR');
    },
  });

  const { run } = await service.runGovernanceSync({ trigger: 'manual' });

  assert.equal(table.runs.length, 1);
  assert.equal(run.status, 'failed');
  assert.equal(run.error_code, 'PROVIDER_ERROR');
  assert.match(run.error_message, /soroban rpc timeout/);
  assert.doesNotMatch(run.error_message, /SCVMQUS5EM/, 'secret seeds never reach history');
  assert.match(run.error_message, /\[redacted-secret\]/);
  assert.equal(run.proposals_updated, 0);
});

test('a database failure during sync is recorded as a failed run', async () => {
  const { service } = buildService({
    performProposalSync: async () => {
      throw taggedError('DATABASE_ERROR', 'connect ECONNREFUSED postgres://crowdpay:hunter2@db:5432/crowdpay');
    },
  });

  const { run } = await service.runGovernanceSync({ trigger: 'manual' });

  assert.equal(run.status, 'failed');
  assert.equal(run.error_code, 'DATABASE_ERROR');
  assert.doesNotMatch(run.error_message, /hunter2/, 'credentials are scrubbed');
});

test('an unexpected error without a code is recorded as SYNC_ERROR', async () => {
  const { service } = buildService({ performProposalSync: async () => { throw new TypeError('boom'); } });
  const { run } = await service.runGovernanceSync({ trigger: 'manual' });
  assert.equal(run.error_code, 'SYNC_ERROR');
});

test('when the database dies before the run can be finalized, the next run finalizes it as abandoned', async () => {
  const table = createRunsTable();
  const { service } = buildService({
    table,
    performProposalSync: async () => { throw taggedError('DATABASE_ERROR', 'connection lost'); },
  });

  table.failNextFinish();
  const { run } = await service.runGovernanceSync({ trigger: 'manual' });
  assert.equal(run.status, 'failed', 'caller still learns the run failed');
  assert.equal(table.runs[0].status, 'running', 'row could not be finalized');

  // Until it is abandoned, it blocks (deduplicates) new triggers.
  const blocked = await service.runGovernanceSync({ trigger: 'scheduled' });
  assert.equal(blocked.deduplicated, true);

  table.advance(service.RUN_ABANDON_AFTER_MS + 1);
  const next = await service.runGovernanceSync({ trigger: 'scheduled' });
  assert.equal(next.deduplicated, false);
  assert.equal(table.runs[0].status, 'failed');
  assert.equal(table.runs[0].error_code, 'ABANDONED');
  assert.equal(table.runs.length, 2);
});

test('concurrent triggers are deduplicated: one run executes, the others get it back', async () => {
  let release;
  let executions = 0;
  const { service, table } = buildService({
    performProposalSync: async () => {
      executions += 1;
      await new Promise((resolve) => { release = resolve; });
      return { proposalsSeen: 1, proposalsUpdated: 0, proposalsMissing: 0, providerCursor: 'proposal:7' };
    },
  });

  const first = service.runGovernanceSync({ trigger: 'manual' });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const [second, third] = await Promise.all([
    service.runGovernanceSync({ trigger: 'scheduled' }),
    service.runGovernanceSync({ trigger: 'manual' }),
  ]);
  release();
  const firstResult = await first;

  assert.equal(executions, 1);
  assert.equal(table.runs.length, 1, 'deduplicated triggers create no run');
  assert.equal(firstResult.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(third.deduplicated, true);
  assert.equal(second.run.id, firstResult.run.id);
});

test('a retry creates a new run linked to the failed one and leaves history untouched', async () => {
  let fail = true;
  const { service, table, audits } = buildService({
    performProposalSync: async () => {
      if (fail) throw taggedError('PROVIDER_ERROR', 'rpc down');
      return { proposalsSeen: 1, proposalsUpdated: 1, proposalsMissing: 0, providerCursor: 'proposal:7' };
    },
  });

  const { run: failed } = await service.runGovernanceSync({ trigger: 'manual' });
  const failedSnapshot = { ...table.runs[0] };
  fail = false;

  const { run: retry, deduplicated } = await service.retryRun(failed.id, { requestedBy: 'admin-2' });

  assert.equal(deduplicated, false);
  assert.equal(table.runs.length, 2);
  assert.equal(retry.trigger, 'retry');
  assert.equal(retry.retry_of_run_id, failed.id);
  assert.equal(retry.status, 'succeeded');
  assert.deepEqual(table.runs[0], failedSnapshot, 'the original failed run is not mutated');
  assert.equal(audits.at(-1).action, 'governance_sync_retried');

  const detail = await service.getRun(failed.id);
  assert.deepEqual(detail.retries.map((r) => r.id), [retry.id]);
});

test('retrying the same failed run again is idempotent', async () => {
  let syncs = 0;
  const { service, table } = buildService({
    performProposalSync: async () => {
      syncs += 1;
      if (syncs === 1) throw taggedError('PROVIDER_ERROR', 'rpc down');
      return { proposalsSeen: 1, proposalsUpdated: 1, proposalsMissing: 0, providerCursor: 'proposal:7' };
    },
  });
  const { run: failed } = await service.runGovernanceSync({ trigger: 'manual' });

  const first = await service.retryRun(failed.id);
  const second = await service.retryRun(failed.id);
  const [third, fourth] = await Promise.all([service.retryRun(failed.id), service.retryRun(failed.id)]);

  assert.equal(syncs, 2, 'proposal state is synced once for the retry, never duplicated');
  assert.equal(table.runs.length, 2);
  for (const r of [second, third, fourth]) {
    assert.equal(r.deduplicated, true);
    assert.equal(r.run.id, first.run.id);
  }
});

test('concurrent retries of one failed run create a single retry', async () => {
  let syncs = 0;
  let release;
  const { service, table } = buildService({
    performProposalSync: async () => {
      syncs += 1;
      if (syncs === 1) throw taggedError('PROVIDER_ERROR', 'rpc down');
      await new Promise((resolve) => { release = resolve; });
      return { proposalsSeen: 1, proposalsUpdated: 1, proposalsMissing: 0, providerCursor: 'proposal:7' };
    },
  });
  const { run: failed } = await service.runGovernanceSync({ trigger: 'manual' });

  const a = service.retryRun(failed.id);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const b = await service.retryRun(failed.id);
  release();
  const aResult = await a;

  assert.equal(table.runs.filter((r) => r.trigger === 'retry').length, 1);
  assert.equal(b.deduplicated, true);
  assert.equal(b.run.id, aResult.run.id);
});

test('only failed runs are retryable and unknown runs 404', async () => {
  const { service } = buildService();
  const { run } = await service.runGovernanceSync({ trigger: 'manual' });

  await assert.rejects(service.retryRun(run.id), (err) => err.statusCode === 409 && err.code === 'SYNC_RUN_NOT_RETRYABLE');
  await assert.rejects(service.retryRun(crypto.randomUUID()), (err) => err.statusCode === 404);
});

test('listRuns validates filters and binds a bounded page', async () => {
  const calls = [];
  const { service } = buildService({
    queryOverride: async (text, params) => {
      calls.push({ text, params });
      if (/COUNT\(\*\)/.test(text)) return { rows: [{ total: 3 }] };
      return { rows: [{ id: 'r1' }] };
    },
  });

  const page = await service.listRuns({ status: 'failed', trigger: 'retry', limit: 10, offset: 20 });

  assert.deepEqual(page, { data: [{ id: 'r1' }], total: 3, limit: 10, offset: 20 });
  assert.match(calls[1].text, /WHERE status = \$1 AND trigger = \$2/);
  assert.match(calls[1].text, /ORDER BY started_at DESC, id DESC\s+LIMIT \$3 OFFSET \$4/);
  assert.deepEqual(calls[1].params, ['failed', 'retry', 10, 20]);

  await assert.rejects(service.listRuns({ status: "failed' OR 1=1" }), (err) => err.statusCode === 400);
  await assert.rejects(service.listRuns({ trigger: 'cron' }), (err) => err.code === 'INVALID_FILTER');
});

test('safeErrorMessage bounds length', () => {
  const { service } = buildService();
  assert.equal(service.safeErrorMessage(new Error('x'.repeat(2000))).length, 500);
});
