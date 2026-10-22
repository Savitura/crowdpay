const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const withTransaction = require('../utils/withTransaction');
const {
  campaignPolicy,
  teamApproval,
  assertTeamApproved,
  insertWithdrawalRequest,
} = require('./withdrawalTeamApproval');

test('team approval migration, snapshot and concurrency on PostgreSQL', async t => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL is not configured');
  const schema = `approval_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    options: `-c search_path=${schema}`,
    max: 5,
  });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end();
    return t.skip('PostgreSQL is unavailable');
  }
  const migration = suffix =>
    fs.readFileSync(
      path.join(
        __dirname,
        '../../db/migrations',
        `20261022_withdrawal_team_approvals${suffix}.sql`
      ),
      'utf8'
    );
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE users (id UUID PRIMARY KEY);
      CREATE TABLE campaigns (id UUID PRIMARY KEY, creator_id UUID REFERENCES users);
      CREATE TABLE campaign_members (id UUID PRIMARY KEY, campaign_id UUID REFERENCES campaigns,
        user_id UUID REFERENCES users, role TEXT, accepted_at TIMESTAMPTZ);
      CREATE TABLE withdrawal_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID REFERENCES campaigns, requested_by UUID REFERENCES users,
        amount NUMERIC(20,7), destination_key TEXT, unsigned_xdr TEXT, evidence JSONB,
        creator_signed BOOLEAN, platform_signed BOOLEAN, is_refund BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'pending', expires_at TIMESTAMPTZ);
    `);
    const creator = randomUUID(),
      owner = randomUUID(),
      outsider = randomUUID(),
      campaignId = randomUUID(),
      member = randomUUID();
    for (const id of [creator, owner, outsider])
      await pool.query('INSERT INTO users VALUES ($1)', [id]);
    await pool.query('INSERT INTO campaigns VALUES ($1,$2)', [campaignId, creator]);
    await pool.query("INSERT INTO campaign_members VALUES ($1,$2,$3,'owner',NOW())", [
      member,
      campaignId,
      owner,
    ]);
    await pool.query(migration(''));
    const tx = fn => withTransaction(fn, pool);
    const makeRequest = () =>
      tx(client =>
        insertWithdrawalRequest(client, {
          campaignId,
          requestedBy: creator,
          amount: '10',
          destinationKey: 'GDEST',
          xdr: 'fixed-xdr',
          evidence: ['receipt'],
        })
      );
    const legacy = await makeRequest();
    assert.equal(legacy.team_approvals_required, 0);
    await tx(client => campaignPolicy(client, campaignId, creator, 1));
    const row = { ...(await makeRequest()), creator_id: creator };
    assert.equal(row.team_approvals_required, 1);
    await tx(client => campaignPolicy(client, campaignId, creator, 0));
    await assert.rejects(
      tx(client => assertTeamApproved(client, row)),
      { status: 409 }
    );
    await assert.rejects(
      tx(client => teamApproval(client, row.id, creator, true)),
      { status: 403 }
    );
    await assert.rejects(
      tx(client => teamApproval(client, row.id, outsider, true)),
      { status: 403 }
    );

    await Promise.all([1, 2].map(() => tx(client => teamApproval(client, row.id, owner, true))));
    assert.equal((await pool.query('SELECT * FROM withdrawal_team_approvals')).rowCount, 1);
    await tx(client => assertTeamApproved(client, row));

    await pool.query("UPDATE campaign_members SET role='viewer' WHERE id=$1", [member]);
    await assert.rejects(
      tx(client => assertTeamApproved(client, row)),
      { status: 409 }
    );
    await pool.query("UPDATE campaign_members SET role='owner', accepted_at=NULL WHERE id=$1", [
      member,
    ]);
    await assert.rejects(
      tx(client => teamApproval(client, row.id, owner, true)),
      { status: 403 }
    );
    await pool.query('DELETE FROM campaign_members WHERE id=$1', [member]);
    await pool.query("INSERT INTO campaign_members VALUES ($1,$2,$3,'owner',NOW())", [
      randomUUID(),
      campaignId,
      owner,
    ]);
    await assert.rejects(
      tx(client => assertTeamApproved(client, row)),
      { status: 409 }
    );
    await tx(client => teamApproval(client, row.id, owner, true));

    // A membership demotion must wait until the platform transaction releases its locks.
    const releaseClient = await pool.connect();
    const removalClient = await pool.connect();
    try {
      await releaseClient.query('BEGIN');
      await assertTeamApproved(releaseClient, row);
      await removalClient.query('BEGIN');
      await removalClient.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        removalClient.query("UPDATE campaign_members SET role='viewer' WHERE user_id=$1", [owner]),
        { code: '55P03' }
      );
      await removalClient.query('ROLLBACK');
      await releaseClient.query('COMMIT');
    } finally {
      releaseClient.release();
      removalClient.release();
    }

    await assert.rejects(pool.query(migration('.down')), /Finish or cancel/);
    await pool.query("UPDATE withdrawal_requests SET status='denied'");
    await pool.query(migration('.down'));
    await pool.query(migration(''));
    assert.equal(
      (
        await pool.query('SELECT team_approvals_required FROM withdrawal_requests WHERE id=$1', [
          row.id,
        ])
      ).rows[0].team_approvals_required,
      0
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
