// Real-PostgreSQL integration coverage for #960 and #961.
//
// The unit tests stub the db so they can pin the exact SQL; these tests run
// against the migrated schema to prove the *constraints* behave: the
// composite primary key, the one-survey-per-campaign unique constraint, the
// one-response-per-backer unique constraint, the CHECK constraints, the
// cascades, and the compare-and-set transitions.
//
// Every test runs inside a transaction that is rolled back afterwards, and
// each expected-constraint-violation runs inside a SAVEPOINT — an aborted
// transaction would otherwise poison every statement that follows.
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../config/database');

const CAMPAIGN_A = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_B = '22222222-2222-4222-8222-222222222222';
const CREATOR = '33333333-3333-4333-8333-333333333333';
const BACKER = '44444444-4444-4444-8444-444444444444';
const BACKER_2 = '55555555-5555-4555-8555-555555555555';
const BACKER_WALLET = 'GBACKERWALLET0000000000000000000000000000000000000000000000';

let available = false;
let client;
let savepointSeq = 0;

test.before(async () => {
  try {
    client = await db.connect();
    await client.query('SELECT 1');
    // Probe for the tables this suite needs. Running the unit tests without
    // `npm run migrate` should skip, not error.
    await client.query('SELECT 1 FROM campaign_communication_preferences LIMIT 1');
    await client.query('SELECT 1 FROM campaign_outcome_surveys LIMIT 1');
    available = true;
  } catch (err) {
    available = false;
    process.stderr.write(
      `[skipped] #960/#961 integration tests need a migrated database: ${err.message}\n`
    );
  }
});

test.after(async () => {
  if (client) client.release();
  await db.end();
});

function skip(t) {
  t.skip('requires a migrated PostgreSQL database (run `npm run migrate`)');
}

/** Runs `fn` inside a SAVEPOINT so an expected violation does not abort the test. */
async function expectConstraintViolation(fn, code) {
  const sp = `sp_${savepointSeq++}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await assert.rejects(fn, err => {
      assert.equal(err.code, code);
      return true;
    });
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  }
}

async function seed() {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO users (id, email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
     VALUES ($1, 'creator@test.dev',  'x', 'Creator',  'GCREATORWALLET', 'x'),
            ($2, 'backer@test.dev',   'x', 'Backer',   $3,               'x'),
            ($4, 'backer2@test.dev',  'x', 'Backer 2', 'GBACKER2WALLET', 'x')`,
    [CREATOR, BACKER, BACKER_WALLET, BACKER_2]
  );
  await client.query(
    `INSERT INTO campaigns (id, creator_id, title, target_amount, asset_type, wallet_public_key, status)
     VALUES ($1, $3, 'Survey campaign', 100, 'USDC', 'GCAMPAIGN1', 'completed'),
            ($2, $3, 'Other campaign',  100, 'USDC', 'GCAMPAIGN2', 'active')`,
    [CAMPAIGN_A, CAMPAIGN_B, CREATOR]
  );
  await client.query(
    `INSERT INTO contributions (campaign_id, sender_public_key, amount, asset, tx_hash)
     VALUES ($1, $2, 10, 'USDC', 'tx-backer-1'),
            ($1, 'GBACKER2WALLET', 10, 'USDC', 'tx-backer-2')`,
    [CAMPAIGN_A, BACKER_WALLET]
  );
}

async function cleanup() {
  await client.query('ROLLBACK');
}

async function insertSurvey(overrides = {}) {
  const row = {
    campaign_id: CAMPAIGN_A,
    created_by: CREATOR,
    title: 'How did it go?',
    questions: [{ id: 'delivery', prompt: 'Rate the delivery', type: 'rating', required: true }],
    status: 'open',
    opens_at: null,
    closes_at: null,
    ...overrides,
  };
  const { rows } = await client.query(
    `INSERT INTO campaign_outcome_surveys
       (campaign_id, created_by, title, questions, status, opens_at, closes_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING id`,
    [
      row.campaign_id,
      row.created_by,
      row.title,
      JSON.stringify(row.questions),
      row.status,
      row.opens_at,
      row.closes_at,
    ]
  );
  return rows[0].id;
}

// ── #961 communication preferences ──────────────────────────────────────────

test('communication preferences: composite primary key keeps one row per (campaign, user)', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await client.query(
      `INSERT INTO campaign_communication_preferences (campaign_id, user_id, milestones)
       VALUES ($1, $2, FALSE)`,
      [CAMPAIGN_A, BACKER]
    );

    // Same pair -> unique violation. This is what makes the ON CONFLICT upsert
    // in the service deterministic rather than best-effort.
    await expectConstraintViolation(
      () =>
        client.query(
          `INSERT INTO campaign_communication_preferences (campaign_id, user_id, milestones)
           VALUES ($1, $2, TRUE)`,
          [CAMPAIGN_A, BACKER]
        ),
      '23505'
    );

    // A different campaign for the same user is a different row.
    await client.query(
      `INSERT INTO campaign_communication_preferences (campaign_id, user_id) VALUES ($1, $2)`,
      [CAMPAIGN_B, BACKER]
    );
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM campaign_communication_preferences WHERE user_id = $1',
      [BACKER]
    );
    assert.equal(rows[0].n, 2);
  } finally {
    await cleanup();
  }
});

test('communication preferences: every channel defaults to TRUE', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await client.query(
      'INSERT INTO campaign_communication_preferences (campaign_id, user_id) VALUES ($1, $2)',
      [CAMPAIGN_A, BACKER]
    );
    const { rows } = await client.query(
      `SELECT updates, milestones, funding_updates, messages, surveys
       FROM campaign_communication_preferences
       WHERE campaign_id = $1 AND user_id = $2`,
      [CAMPAIGN_A, BACKER]
    );
    for (const [channel, value] of Object.entries(rows[0])) {
      assert.equal(value, true, `${channel} must default to true`);
    }
  } finally {
    await cleanup();
  }
});

test('communication preferences: a partial upsert leaves the other channels alone', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await client.query(
      `INSERT INTO campaign_communication_preferences (campaign_id, user_id, messages)
       VALUES ($1, $2, FALSE)`,
      [CAMPAIGN_A, BACKER]
    );
    // The exact statement the service emits for a one-channel toggle.
    await client.query(
      `INSERT INTO campaign_communication_preferences (campaign_id, user_id, surveys)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (campaign_id, user_id) DO UPDATE
         SET surveys = EXCLUDED.surveys, updated_at = NOW()`,
      [CAMPAIGN_A, BACKER]
    );
    const { rows } = await client.query(
      `SELECT messages, surveys, updates FROM campaign_communication_preferences
       WHERE campaign_id = $1 AND user_id = $2`,
      [CAMPAIGN_A, BACKER]
    );
    assert.equal(rows[0].messages, false, 'the earlier mute survives');
    assert.equal(rows[0].surveys, false, 'the new mute is written');
    assert.equal(rows[0].updates, true, 'untouched channels keep their value');
  } finally {
    await cleanup();
  }
});

test('communication preferences: deleting a campaign cascades its overrides', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    // CAMPAIGN_B has no contributions, so the delete is not blocked by the
    // contribution FK before the cascade runs.
    await client.query(
      'INSERT INTO campaign_communication_preferences (campaign_id, user_id) VALUES ($1, $2)',
      [CAMPAIGN_B, BACKER]
    );
    await client.query('DELETE FROM campaigns WHERE id = $1', [CAMPAIGN_B]);
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM campaign_communication_preferences WHERE campaign_id = $1',
      [CAMPAIGN_B]
    );
    assert.equal(rows[0].n, 0);
  } finally {
    await cleanup();
  }
});

// ── #960 outcome surveys ────────────────────────────────────────────────────

test('outcome surveys: one survey per campaign is enforced by the unique constraint', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await insertSurvey({ title: 'First' });
    await expectConstraintViolation(() => insertSurvey({ title: 'Second' }), '23505');
  } finally {
    await cleanup();
  }
});

test('outcome surveys: status CHECK rejects an unknown lifecycle value', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await expectConstraintViolation(() => insertSurvey({ status: 'archived' }), '23514');
  } finally {
    await cleanup();
  }
});

test('outcome surveys: a close window cannot precede the open window', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await expectConstraintViolation(
      () => insertSurvey({ opens_at: '2026-10-01T00:00:00Z', closes_at: '2026-09-01T00:00:00Z' }),
      '23514'
    );
  } finally {
    await cleanup();
  }
});

test('outcome surveys: a non-array questions column is rejected', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await expectConstraintViolation(() => insertSurvey({ questions: { a: 1 } }), '23514');
  } finally {
    await cleanup();
  }
});

test('outcome surveys: an oversized title is rejected', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    await expectConstraintViolation(() => insertSurvey({ title: 'x'.repeat(201) }), '23514');
  } finally {
    await cleanup();
  }
});

test('outcome surveys: one response per backer is enforced, so a duplicate loses the race', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const surveyId = await insertSurvey();
    const insert = value =>
      client.query(
        `INSERT INTO campaign_outcome_survey_responses (survey_id, campaign_id, user_id, answers)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (survey_id, user_id) DO NOTHING
         RETURNING id`,
        [surveyId, CAMPAIGN_A, BACKER, JSON.stringify({ delivery: value })]
      );

    assert.equal((await insert(5)).rows.length, 1, 'the first submission is stored');
    assert.equal(
      (await insert(1)).rows.length,
      0,
      'the duplicate loses and the service reports 409'
    );

    const { rows } = await client.query(
      'SELECT answers FROM campaign_outcome_survey_responses WHERE survey_id = $1 AND user_id = $2',
      [surveyId, BACKER]
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].answers, { delivery: 5 }, 'the loser does not overwrite the winner');

    const { rows: countRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM campaign_outcome_survey_responses WHERE survey_id = $1',
      [surveyId]
    );
    assert.equal(countRows[0].n, 1);
  } finally {
    await cleanup();
  }
});

test('outcome surveys: a different backer may still answer the same survey', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const surveyId = await insertSurvey();
    for (const backer of [BACKER, BACKER_2]) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      await client.query(
        `INSERT INTO campaign_outcome_survey_responses (survey_id, campaign_id, user_id)
         VALUES ($1, $2, $3)`,
        [surveyId, CAMPAIGN_A, backer]
      );
    }
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM campaign_outcome_survey_responses WHERE survey_id = $1',
      [surveyId]
    );
    assert.equal(rows[0].n, 2);
  } finally {
    await cleanup();
  }
});

test('outcome surveys: a non-object answers column is rejected', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const surveyId = await insertSurvey();
    await expectConstraintViolation(
      () =>
        client.query(
          `INSERT INTO campaign_outcome_survey_responses (survey_id, campaign_id, user_id, answers)
           VALUES ($1, $2, $3, '[]'::jsonb)`,
          [surveyId, CAMPAIGN_A, BACKER]
        ),
      '23514'
    );
  } finally {
    await cleanup();
  }
});

test('outcome surveys: deleting a campaign cascades the survey, responses, and events', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const surveyId = await insertSurvey();
    await client.query(
      `INSERT INTO campaign_outcome_survey_responses (survey_id, campaign_id, user_id)
       VALUES ($1, $2, $3)`,
      [surveyId, CAMPAIGN_A, BACKER]
    );
    await client.query(
      `INSERT INTO campaign_outcome_survey_events (survey_id, campaign_id, to_status)
       VALUES ($1, $2, 'open')`,
      [surveyId, CAMPAIGN_A]
    );

    // The contribution FK is not cascading, so remove the contributions first
    // and prove the *survey* cascade independently.
    await client.query('DELETE FROM contributions WHERE campaign_id = $1', [CAMPAIGN_A]);
    await client.query('DELETE FROM campaigns WHERE id = $1', [CAMPAIGN_A]);

    for (const table of [
      'campaign_outcome_surveys',
      'campaign_outcome_survey_responses',
      'campaign_outcome_survey_events',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE campaign_id = $1`,
        [CAMPAIGN_A]
      );
      assert.equal(rows[0].n, 0, `${table} rows must cascade with the campaign`);
    }
  } finally {
    await cleanup();
  }
});

test('outcome surveys: the compare-and-set open transition is race-safe', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const surveyId = await insertSurvey({ status: 'draft' });
    const open = () =>
      client.query(
        `UPDATE campaign_outcome_surveys
         SET status = 'open', published_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'draft'
         RETURNING id`,
        [surveyId]
      );

    const results = await Promise.all([open(), open()]);
    const winners = results.reduce((sum, result) => sum + result.rows.length, 0);
    assert.equal(winners, 1, 'exactly one concurrent publisher wins; the other gets a 409');
  } finally {
    await cleanup();
  }
});

test('outcome surveys: the close transition cannot move a draft', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const surveyId = await insertSurvey({ status: 'draft' });
    const { rows } = await client.query(
      `UPDATE campaign_outcome_surveys
       SET status = 'closed', closed_at = NOW()
       WHERE id = $1 AND status = 'open'
       RETURNING id`,
      [surveyId]
    );
    assert.equal(rows.length, 0, 'a draft cannot be closed through the open-only path');
  } finally {
    await cleanup();
  }
});

test('outcome surveys: questions round-trip through JSONB unchanged', async t => {
  if (!available) return skip(t);
  await seed();
  try {
    const questions = [
      {
        id: 'delivery',
        prompt: 'Rate the delivery',
        type: 'rating',
        required: true,
        options: null,
      },
      {
        id: 'reuse',
        prompt: 'Back again?',
        type: 'single_choice',
        required: true,
        options: ['Yes', 'No'],
      },
      { id: 'notes', prompt: 'Anything else?', type: 'text', required: false, options: null },
    ];
    const surveyId = await insertSurvey({ questions });
    const { rows } = await client.query(
      'SELECT questions FROM campaign_outcome_surveys WHERE id = $1',
      [surveyId]
    );
    assert.deepEqual(rows[0].questions, questions);
  } finally {
    await cleanup();
  }
});
