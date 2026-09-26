// Real-Postgres check of the webhook delivery claim SQL (#838). Runs only
// when DATABASE_URL points at a migrated database; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const DATABASE_URL = process.env.DATABASE_URL;

async function openPool() {
  if (!DATABASE_URL) return null;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'webhook_deliveries' AND column_name = 'lease_token'`
    );
    if (rows.length) return pool;
  } catch {
    // unreachable database: skip
  }
  await pool.end();
  return null;
}

test('claim SQL against Postgres', async (t) => {
  const pool = await openPool();
  if (!pool) {
    t.skip('DATABASE_URL not set or not migrated');
    return;
  }

  const sent = [];
  const dispatcher = proxyquire('./webhookDispatcher', {
    '../config/database': pool,
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './emailService': { sendEmail: async () => {} },
    '../utils/safeFetch': {
      safeFetch: async (_url, opts) => {
        sent.push(opts.headers['X-CrowdPay-Delivery-Id']);
        return { ok: true, status: 200, text: async () => 'ok' };
      },
    },
  });

  const suffix = crypto.randomBytes(6).toString('hex');
  const { rows: users } = await pool.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
     VALUES ($1, 'x', 'Webhook Claim Test', $2, 'x') RETURNING id`,
    [`webhook-claims-${suffix}@example.test`, `GWEBHOOKCLAIMTEST${suffix}`]
  );
  const userId = users[0].id;
  const { rows: hooks } = await pool.query(
    `INSERT INTO webhooks (user_id, url, events, secret)
     VALUES ($1, 'https://receiver.example/hook', ARRAY['campaign.funded'], 'whsec_test') RETURNING id`,
    [userId]
  );
  const webhookId = hooks[0].id;

  async function insertDelivery(fields = {}) {
    const { rows } = await pool.query(
      `INSERT INTO webhook_deliveries
         (webhook_id, event_type, payload, status, attempt_count, next_retry_at, lease_token, lease_expires_at)
       VALUES ($1, 'campaign.funded', '{"n":1}'::jsonb, $2, $3, $4, $5, $6) RETURNING id`,
      [
        webhookId,
        fields.status || 'pending',
        fields.attempt_count || 0,
        fields.next_retry_at || null,
        fields.lease_token || null,
        fields.lease_expires_at || null,
      ]
    );
    return rows[0].id;
  }

  const fetchRow = async (id) =>
    (await pool.query('SELECT status, attempt_count, lease_token FROM webhook_deliveries WHERE id = $1', [id])).rows[0];

  try {
    await t.test('only one of many concurrent claims wins', async () => {
      const id = await insertDelivery();
      const claims = await Promise.all(
        Array.from({ length: 6 }, () => dispatcher.claimDelivery('user', id))
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const row = await fetchRow(id);
      assert.equal(row.status, 'delivering');
      assert.equal(row.attempt_count, 1);
    });

    await t.test('concurrent workers send one request and record one attempt', async () => {
      sent.length = 0;
      const id = await insertDelivery({ status: 'retrying', attempt_count: 1, next_retry_at: new Date(Date.now() - 1000) });
      await Promise.all([dispatcher.processDelivery(id), dispatcher.processDelivery(id), dispatcher.processDelivery(id)]);
      assert.deepEqual(sent, [id]);
      const row = await fetchRow(id);
      assert.equal(row.status, 'delivered');
      assert.equal(row.attempt_count, 2);
      assert.equal(row.lease_token, null);
    });

    await t.test('a live lease blocks reclaim; an expired lease is recoverable', async () => {
      const live = await insertDelivery({ status: 'delivering', attempt_count: 1, lease_token: 'other', lease_expires_at: new Date(Date.now() + 60_000) });
      assert.equal(await dispatcher.claimDelivery('user', live), null);

      const expired = await insertDelivery({ status: 'delivering', attempt_count: 1, lease_token: 'dead', lease_expires_at: new Date(Date.now() - 1000) });
      const claimed = await dispatcher.claimDelivery('user', expired);
      assert.ok(claimed);
      assert.equal(claimed.attempt_count, 2);
      assert.notEqual(claimed.lease_token, 'dead');
    });
  } finally {
    await pool.query('DELETE FROM webhooks WHERE id = $1', [webhookId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  }
});
