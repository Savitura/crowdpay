// Real-Postgres check of the automatic milestone release SQL (#930): the
// migration's constraints, the claim/finalize transactions, dispute halting,
// and restart recovery. Runs only when DATABASE_URL points at a migrated
// database; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const DATABASE_URL = process.env.DATABASE_URL;
const DESTINATION = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';

async function openPool() {
  if (!DATABASE_URL) return null;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'milestone_auto_release_attempts'`
    );
    if (rows.length) return pool;
  } catch {
    // unreachable database: skip
  }
  await pool.end();
  return null;
}

function loadService(pool) {
  process.env.STORAGE_ENDPOINT = 'https://storage.test';
  process.env.STORAGE_BUCKET = 'evidence';
  return proxyquire('./milestoneAutoRelease', {
    '../config/database': pool,
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    './stellarService': {},
    './alerting': { sendAlert: () => {} },
  });
}

function fakeStellar() {
  const s = {
    ledger: new Set(),
    submissions: 0,
    built: 0,
    async buildWithdrawalTransaction() {
      s.built += 1;
      return `xdr-${crypto.randomBytes(6).toString('hex')}`;
    },
    signTransactionXdr: ({ xdr }) => `${xdr}+sig`,
    signatureCountFromXdr: xdr => xdr.split('+sig').length - 1,
    transactionHashFromXdr: xdr => crypto.createHash('sha256').update(xdr).digest('hex'),
    async submitSignedWithdrawal({ xdr }) {
      s.submissions += 1;
      s.ledger.add(s.transactionHashFromXdr(xdr));
    },
    getTransactionOutcome: async hash => (s.ledger.has(hash) ? 'success' : 'not_found'),
    isDefinitiveSubmissionFailure: () => false,
    isXdrExpired: () => false,
  };
  return s;
}

function depsFor(stellar) {
  return {
    stellar,
    withDecryptedWalletSecret: async (_c, _ctx, fn) => fn('SCREATOR'),
    evidenceExists: async () => true,
    afterRelease: async () => {},
    alert: () => {},
  };
}

async function seedCampaign(pool, suffix) {
  const { rows: users } = await pool.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key)
     VALUES ($1, 'x', 'Auto Release Test', $2) RETURNING id`,
    [`auto-release-${suffix}@example.test`, `GAUTORELEASE${suffix.toUpperCase()}`]
  );
  const { rows: campaigns } = await pool.query(
    `INSERT INTO campaigns (creator_id, title, target_amount, raised_amount, asset_type, status, wallet_public_key)
     VALUES ($1, 'Auto release campaign', 1000, 1000, 'USDC', 'funded', $2) RETURNING id`,
    [users[0].id, `GCAMPAIGNAUTO${suffix.toUpperCase()}`]
  );
  return { creatorId: users[0].id, campaignId: campaigns[0].id };
}

async function seedSubmittedMilestone(
  pool,
  service,
  campaignId,
  { windowSeconds = 72 * 3600 } = {}
) {
  const { rows } = await pool.query(
    `INSERT INTO milestones (campaign_id, title, release_percentage, status, destination_key,
                             auto_release_enabled, auto_release_rule, auto_release_window_seconds,
                             auto_release_status)
     VALUES ($1, 'Ship it', 50, 'pending_review', $2, TRUE, 'platform_evidence', $3, 'awaiting_evidence')
     RETURNING *`,
    [campaignId, DESTINATION, windowSeconds]
  );
  const sha = crypto.randomBytes(32).toString('hex');
  const url = `https://storage.test/evidence/${encodeURIComponent(`milestones/${rows[0].id}/${sha}.png`)}`;
  await pool.query('UPDATE milestones SET evidence_url = $2 WHERE id = $1', [rows[0].id, url]);
  const scheduled = await service.scheduleOnSubmission(
    pool,
    { ...rows[0], evidence_url: url },
    { evidenceExists: true }
  );
  return scheduled;
}

/** Move a schedule into the past so its window has elapsed, as if time had passed. */
async function elapseWindow(pool, milestoneId) {
  await pool.query(
    `UPDATE milestones
     SET auto_release_scheduled_at = auto_release_scheduled_at - (auto_release_window_seconds + 60) * INTERVAL '1 second',
         auto_release_at = auto_release_at - (auto_release_window_seconds + 60) * INTERVAL '1 second'
     WHERE id = $1`,
    [milestoneId]
  );
}

test('automatic milestone release against Postgres', async t => {
  const pool = await openPool();
  if (!pool) {
    t.skip('DATABASE_URL not set or not migrated');
    return;
  }
  const service = loadService(pool);
  const repo = service.createSqlRepository(pool);
  const run = stellar => service.processAutoReleases({ repo, deps: depsFor(stellar) });

  try {
    await t.test('the database refuses a window below the 24h minimum', async () => {
      const { campaignId } = await seedCampaign(pool, crypto.randomBytes(4).toString('hex'));
      await assert.rejects(
        pool.query(
          `INSERT INTO milestones (campaign_id, title, release_percentage, auto_release_enabled,
                                   auto_release_rule, auto_release_window_seconds)
           VALUES ($1, 'Too short', 10, TRUE, 'platform_evidence', 3600)`,
          [campaignId]
        ),
        { code: '23514' }
      );
      const scheduled = await seedSubmittedMilestone(pool, service, campaignId);
      await assert.rejects(
        pool.query(
          `UPDATE milestones SET auto_release_at = auto_release_scheduled_at + INTERVAL '1 hour' WHERE id = $1`,
          [scheduled.id]
        ),
        { code: '23514' }
      );
    });

    await t.test('release fires after the window, once, with an auditable rule', async () => {
      const { campaignId } = await seedCampaign(pool, crypto.randomBytes(4).toString('hex'));
      const scheduled = await seedSubmittedMilestone(pool, service, campaignId);
      assert.equal(scheduled.auto_release_status, 'scheduled');
      assert.equal(
        new Date(scheduled.auto_release_at) - new Date(scheduled.auto_release_scheduled_at),
        72 * 3600 * 1000
      );

      const stellar = fakeStellar();
      await run(stellar);
      assert.equal(stellar.submissions, 0, 'window still open');

      await elapseWindow(pool, scheduled.id);
      const results = await run(stellar);
      assert.equal(results.find(r => r.milestoneId === scheduled.id)?.outcome, 'released');
      await run(stellar);
      assert.equal(stellar.submissions, 1);

      const {
        rows: [m],
      } = await pool.query('SELECT * FROM milestones WHERE id = $1', [scheduled.id]);
      assert.equal(m.status, 'released');
      assert.equal(m.release_trigger, 'auto');
      assert.equal(m.auto_release_status, 'released');

      const { rows: withdrawals } = await pool.query(
        'SELECT * FROM withdrawal_requests WHERE milestone_id = $1',
        [scheduled.id]
      );
      assert.equal(withdrawals.length, 1);
      assert.equal(Number(withdrawals[0].amount), 500);

      const { rows: audit } = await pool.query(
        `SELECT metadata FROM audit_logs WHERE action = 'milestone.auto_released' AND resource_id = $1`,
        [String(scheduled.id)]
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0].metadata.release_mode, 'automatic');
      assert.equal(audit[0].metadata.rule, 'platform_evidence');

      const { rows: events } = await pool.query(
        `SELECT action FROM milestone_events WHERE milestone_id = $1 ORDER BY created_at`,
        [scheduled.id]
      );
      const actions = events.map(e => e.action);
      assert.ok(actions.includes('auto_release_scheduled'));
      assert.ok(actions.includes('auto_released'));

      const {
        rows: [campaign],
      } = await pool.query('SELECT status FROM campaigns WHERE id = $1', [campaignId]);
      assert.equal(campaign.status, 'completed');
    });

    await t.test('a dispute inside the window halts the release', async () => {
      const { campaignId, creatorId } = await seedCampaign(
        pool,
        crypto.randomBytes(4).toString('hex')
      );
      const scheduled = await seedSubmittedMilestone(pool, service, campaignId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const {
          rows: [dispute],
        } = await client.query(
          `INSERT INTO disputes (campaign_id, raised_by, reason, description, milestone_id)
           VALUES ($1, $2, 'non_delivery', 'Not delivered', $3) RETURNING id`,
          [campaignId, creatorId, scheduled.id]
        );
        const halted = await service.haltScheduledReleases(client, {
          campaignId,
          disputeId: dispute.id,
          milestoneId: scheduled.id,
        });
        await client.query('COMMIT');
        assert.deepEqual(halted, [scheduled.id]);
      } finally {
        client.release();
      }

      await elapseWindow(pool, scheduled.id);
      const stellar = fakeStellar();
      await run(stellar);
      assert.equal(stellar.submissions, 0);

      const {
        rows: [m],
      } = await pool.query('SELECT * FROM milestones WHERE id = $1', [scheduled.id]);
      assert.equal(m.auto_release_status, 'halted');
      assert.equal(m.auto_release_halt_reason, 'dispute_opened');
      assert.equal(m.status, 'pending_review');
      const { rows: attempts } = await pool.query(
        'SELECT 1 FROM milestone_auto_release_attempts WHERE milestone_id = $1',
        [scheduled.id]
      );
      assert.equal(attempts.length, 0);
    });

    await t.test('a restart after submission recovers by hash without paying twice', async () => {
      const { campaignId } = await seedCampaign(pool, crypto.randomBytes(4).toString('hex'));
      const scheduled = await seedSubmittedMilestone(pool, service, campaignId);
      await elapseWindow(pool, scheduled.id);

      const stellar = fakeStellar();
      const crashingRepo = {
        ...repo,
        finalizeRelease: async () => {
          throw new Error('simulated crash');
        },
      };
      await service.processAutoReleases({ repo: crashingRepo, deps: depsFor(stellar) });
      assert.equal(stellar.submissions, 1);

      const {
        rows: [attempt],
      } = await pool.query(
        'SELECT * FROM milestone_auto_release_attempts WHERE milestone_id = $1',
        [scheduled.id]
      );
      assert.equal(attempt.status, 'submitted');
      assert.ok(attempt.tx_hash && attempt.signed_xdr, 'envelope persisted before submission');

      await run(stellar);
      assert.equal(stellar.submissions, 1, 'lease still held: the new worker waits');

      await pool.query(
        `UPDATE milestone_auto_release_attempts SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [attempt.id]
      );
      await run(stellar);

      assert.equal(stellar.submissions, 1);
      assert.equal(stellar.built, 1);
      const { rows: withdrawals } = await pool.query(
        'SELECT 1 FROM withdrawal_requests WHERE milestone_id = $1',
        [scheduled.id]
      );
      assert.equal(withdrawals.length, 1);
      const {
        rows: [m],
      } = await pool.query('SELECT status, release_trigger FROM milestones WHERE id = $1', [
        scheduled.id,
      ]);
      assert.deepEqual(m, { status: 'released', release_trigger: 'auto' });

      // The UNIQUE milestone_id makes a second attempt impossible at the database level.
      await assert.rejects(
        pool.query(
          `INSERT INTO milestone_auto_release_attempts
             (milestone_id, campaign_id, rule, window_seconds, scheduled_at, fires_at, evidence_url, amount, destination_key)
           VALUES ($1, $2, 'platform_evidence', 86400, NOW(), NOW(), 'x', 1, $3)`,
          [scheduled.id, campaignId, DESTINATION]
        ),
        { code: '23505' }
      );
    });
  } finally {
    await pool.end();
  }
});
