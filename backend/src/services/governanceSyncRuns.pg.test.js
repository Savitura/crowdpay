'use strict';

// Real-Postgres check of the governance_sync_runs rules (#839): one running
// run, one retry per failed run, immutable finished rows. Runs only when
// DATABASE_URL points at a migrated database; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

async function openPool() {
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  try {
    const { rows } = await pool.query(`SELECT to_regclass('governance_sync_runs') AS t`);
    if (rows[0].t) return pool;
  } catch {
    // unreachable database: skip
  }
  await pool.end();
  return null;
}

test('governance_sync_runs rules against Postgres', async (t) => {
  const pool = await openPool();
  if (!pool) {
    t.skip('DATABASE_URL not set or not migrated');
    return;
  }

  // Serialize with any other user of the table in this database.
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock(839839)');
  const created = [];
  let outcome = 'ok';

  const service = proxyquire('./governanceSyncRuns', {
    '../config/database': pool,
    '../config/logger': silentLogger,
    './governance': {
      performProposalSync: async () => {
        if (outcome === 'fail') {
          const err = new Error('rpc down');
          err.code = 'PROVIDER_ERROR';
          throw err;
        }
        return { proposalsSeen: 1, proposalsUpdated: 1, proposalsMissing: 0, providerCursor: 'proposal:1' };
      },
    },
    './auditService': { logAuditEvent: async () => {} },
  });

  try {
    await pool.query(`UPDATE governance_sync_runs SET status = 'failed', finished_at = NOW(), error_code = 'ABANDONED' WHERE status = 'running'`);

    await t.test('the database allows only one running run', async () => {
      const { rows } = await pool.query(`INSERT INTO governance_sync_runs (trigger) VALUES ('manual') RETURNING id`);
      created.push(rows[0].id);
      await assert.rejects(
        pool.query(`INSERT INTO governance_sync_runs (trigger) VALUES ('scheduled')`),
        (err) => err.code === '23505'
      );
      const dedup = await service.runGovernanceSync({ trigger: 'manual' });
      assert.equal(dedup.deduplicated, true);
      assert.equal(dedup.run.id, rows[0].id);
      await pool.query(
        `UPDATE governance_sync_runs SET status = 'succeeded', finished_at = NOW() WHERE id = $1`,
        [rows[0].id]
      );
    });

    await t.test('finished runs are immutable', async () => {
      await assert.rejects(
        pool.query(`UPDATE governance_sync_runs SET proposals_updated = 99 WHERE id = $1`, [created[0]]),
        /immutable/
      );
    });

    await t.test('a failed run gets one linked retry, repeat retries return it', async () => {
      outcome = 'fail';
      const { run: failed } = await service.runGovernanceSync({ trigger: 'manual' });
      created.push(failed.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error_code, 'PROVIDER_ERROR');

      outcome = 'ok';
      const [a, b] = await Promise.all([service.retryRun(failed.id), service.retryRun(failed.id)]);
      const retries = await pool.query('SELECT id, status FROM governance_sync_runs WHERE retry_of_run_id = $1', [failed.id]);
      created.push(...retries.rows.map((r) => r.id));
      assert.equal(retries.rows.length, 1);
      assert.equal(retries.rows[0].status, 'succeeded');
      assert.equal(a.run.id, b.run.id);
      assert.ok(a.deduplicated !== b.deduplicated, 'exactly one caller started the retry');

      const page = await service.listRuns({ status: 'failed', limit: 50, offset: 0 });
      assert.ok(page.data.some((r) => r.id === failed.id));
      assert.ok(page.data.every((r) => r.status === 'failed'));
    });

    await t.test('retention purges expired runs leaf-first without breaking retry links', async () => {
      const insert = async (fields) => {
        const { rows } = await pool.query(
          `INSERT INTO governance_sync_runs (trigger, status, retry_of_run_id, started_at, finished_at, error_code)
           VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
          [fields.trigger, fields.status, fields.retryOf || null, fields.at, fields.status === 'failed' ? 'PROVIDER_ERROR' : null]
        );
        created.push(rows[0].id);
        return rows[0].id;
      };
      const old = new Date(Date.now() - 400 * 86400000);
      const recent = new Date(Date.now() - 86400000);
      const oldFailed = await insert({ trigger: 'manual', status: 'failed', at: old });
      await insert({ trigger: 'retry', status: 'succeeded', retryOf: oldFailed, at: old });
      const keptParent = await insert({ trigger: 'manual', status: 'failed', at: old });
      const recentRetry = await insert({ trigger: 'retry', status: 'succeeded', retryOf: keptParent, at: recent });

      await service.purgeExpiredRuns({ retentionDays: 180 });

      const { rows } = await pool.query('SELECT id FROM governance_sync_runs WHERE id = ANY($1::uuid[])', [created]);
      const remaining = new Set(rows.map((r) => r.id));
      assert.equal(remaining.has(oldFailed), false, 'expired chain removed');
      assert.equal(remaining.has(keptParent), true, 'kept while a retained retry points at it');
      assert.equal(remaining.has(recentRetry), true);
    });

    await t.test('deleting an operator anonymizes requested_by on finished runs', async () => {
      const { rows: users } = await pool.query(
        `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
         VALUES ($1, 'x', 'Operator', $2, 'x') RETURNING id`,
        [`gov-sync-${Date.now()}@example.test`, `GGOVSYNC${Date.now()}`]
      );
      const { run } = await service.runGovernanceSync({ trigger: 'manual', requestedBy: users[0].id });
      created.push(run.id);
      await pool.query('DELETE FROM users WHERE id = $1', [users[0].id]);
      const { rows } = await pool.query('SELECT requested_by, status FROM governance_sync_runs WHERE id = $1', [run.id]);
      assert.equal(rows[0].requested_by, null);
      assert.equal(rows[0].status, 'succeeded');
    });
  } finally {
    if (created.length) {
      await pool.query('ALTER TABLE governance_sync_runs DISABLE TRIGGER governance_sync_runs_immutable_trg');
      await pool.query('DELETE FROM governance_sync_runs WHERE id = ANY($1::uuid[])', [created]);
      await pool.query('ALTER TABLE governance_sync_runs ENABLE TRIGGER governance_sync_runs_immutable_trg');
    }
    await lock.query('SELECT pg_advisory_unlock(839839)');
    lock.release();
    await pool.end();
  }
});
