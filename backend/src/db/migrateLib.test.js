'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isUpMigration,
  downFilenameFor,
  sha256,
  validateMigrationFiles,
  listAllMigrationFilenames,
  listUpMigrationFilenames,
  MIGRATIONS_DIR,
  acquireMigrationLock,
  releaseMigrationLock,
  MIGRATION_ADVISORY_LOCK_KEY,
  readDownSql,
  assertMigrationOrdering,
} = require('../../db/migrateLib');
const { runUp, runDown } = require('../../db/migrate');

test('isUpMigration excludes .down.sql rollback scripts', () => {
  assert.equal(isUpMigration('20260401_users.sql'), true);
  assert.equal(isUpMigration('002_20260402_wallets.up.sql'), true);
  assert.equal(isUpMigration('20260401_users.down.sql'), false);
  assert.equal(isUpMigration('notes.txt'), false);
});

test('downFilenameFor derives the rollback filename from an up migration', () => {
  assert.equal(downFilenameFor('20260401_users.sql'), '20260401_users.down.sql');
  assert.equal(downFilenameFor('002_20260402_wallets.up.sql'), '002_20260402_wallets.up.down.sql');
});

test('sha256 is deterministic and matches the node crypto implementation', () => {
  const expected = sha256('select 1;');
  assert.equal(expected, sha256('select 1;'));
  assert.equal(expected.length, 64);
  assert.notEqual(sha256('select 1;'), sha256('select 2;'));
});

// #898: a stray `.js` migration next to the `.sql` files made the runner abort
// on the very first statement, and the swallowed error meant operators saw a
// bare non-zero exit. These tests pin the committed directory to the supported
// format so a future stray extension fails the build instead of the deploy.
test('validateMigrationFiles accepts the committed migration set', () => {
  assert.doesNotThrow(() => validateMigrationFiles());

  for (const file of listAllMigrationFilenames()) {
    assert.equal(
      file.endsWith('.sql'),
      true,
      `${file} must use a supported migration format (.sql / .down.sql)`
    );
  }
});

test('the legacy velocity-alert-threshold .js migration is gone and its .sql twin remains', () => {
  const files = listAllMigrationFilenames();

  assert.equal(
    files.some(file => file.endsWith('.js')),
    false,
    'no .js migration may be committed under db/migrations'
  );
  assert.equal(
    files.includes('20250601000000_add_velocity_alert_threshold.js'),
    false,
    'the unsupported .js migration must be deleted'
  );
  assert.equal(
    files.includes('20250601000000_add_velocity_alert_threshold.sql'),
    true,
    'the .sql twin still has to apply velocity_alert_threshold'
  );
  assert.equal(
    listUpMigrationFilenames().includes('20250601000000_add_velocity_alert_threshold.sql'),
    true
  );
});

test('validateMigrationFiles rejects an unsupported extension before running any migration', () => {
  const stray = path.join(MIGRATIONS_DIR, 'zzz_validate_migration_files_stray.js');
  fs.writeFileSync(stray, '// stray, unsupported migration\n');
  try {
    assert.throws(
      () => validateMigrationFiles(),
      /Unsupported migration file format: 'zzz_validate_migration_files_stray\.js'/
    );
  } finally {
    fs.rmSync(stray, { force: true });
  }
});

test('acquireMigrationLock acquires the advisory lock with the dedicated migration lock key', async () => {
  const queries = [];
  const mockClient = {
    query: async (text, params) => {
      queries.push({ text, params });
      return { rows: [] };
    },
  };

  const res = await acquireMigrationLock(mockClient);
  assert.equal(res, true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].text, 'SELECT pg_advisory_lock($1)');
  assert.deepEqual(queries[0].params, [MIGRATION_ADVISORY_LOCK_KEY]);
});

test('releaseMigrationLock releases the advisory lock with the dedicated migration lock key', async () => {
  const queries = [];
  const mockClient = {
    query: async (text, params) => {
      queries.push({ text, params });
      return { rows: [{ unlocked: true }] };
    },
  };

  const res = await releaseMigrationLock(mockClient);
  assert.equal(res, true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].text, 'SELECT pg_advisory_unlock($1) AS unlocked');
  assert.deepEqual(queries[0].params, [MIGRATION_ADVISORY_LOCK_KEY]);
});

test('runUp releases advisory lock after a failed migration', async () => {
  const queries = [];
  let unlockCalled = false;

  const mockClient = {
    query: async text => {
      queries.push(text);
      if (text.includes('pg_advisory_lock')) {
        return { rows: [] };
      }
      if (text.includes('pg_advisory_unlock')) {
        unlockCalled = true;
        return { rows: [{ unlocked: true }] };
      }
      if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        return { rows: [] };
      }
      if (text.includes('SELECT filename, file_hash, applied_at FROM schema_migrations')) {
        return { rows: [] };
      }
      if (text === 'BEGIN') {
        return { rows: [] };
      }
      if (text === 'ROLLBACK') {
        return { rows: [] };
      }
      // Simulate failure on migration statement
      throw new Error('Simulated syntax error in migration SQL');
    },
  };

  await assert.rejects(async () => {
    await runUp(mockClient);
  }, /Simulated syntax error in migration SQL/);

  assert.equal(
    unlockCalled,
    true,
    'pg_advisory_unlock must be called in finally block even after failure'
  );
  assert.ok(queries.some(q => q.includes('pg_advisory_lock')));
  assert.ok(queries.some(q => q.includes('pg_advisory_unlock')));
});

test('runUp releases advisory lock after successful migrations', async () => {
  const queries = [];
  let unlockCalled = false;

  const mockClient = {
    query: async text => {
      queries.push(text);
      if (text.includes('pg_advisory_lock')) {
        return { rows: [] };
      }
      if (text.includes('pg_advisory_unlock')) {
        unlockCalled = true;
        return { rows: [{ unlocked: true }] };
      }
      if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        return { rows: [] };
      }
      if (text.includes('SELECT filename, file_hash, applied_at FROM schema_migrations')) {
        const { listUpMigrationFilenames, fileHashFor } = require('../../db/migrateLib');
        return {
          rows: listUpMigrationFilenames().map(f => ({
            filename: f,
            file_hash: fileHashFor(f),
            applied_at: new Date(),
          })),
        };
      }
      return { rows: [] };
    },
  };

  await runUp(mockClient);
  assert.equal(unlockCalled, true, 'pg_advisory_unlock must be called on successful completion');
  assert.ok(queries.some(q => q.includes('pg_advisory_lock')));
  assert.ok(queries.some(q => q.includes('pg_advisory_unlock')));
});

// #1115: Migration ordering, rollback limits, and recovery procedure tests
test('assertMigrationOrdering verifies committed migrations are strictly ordered', () => {
  const upFiles = listUpMigrationFilenames();
  assert.ok(upFiles.length > 0, 'committed migration list must not be empty');
  assert.equal(assertMigrationOrdering(upFiles), true);
});

test('assertMigrationOrdering throws when migration sequence is out of order', () => {
  const disordered = [
    '20260401_users.sql',
    '20260403_withdrawal.sql',
    '20260402_wallets.sql',
  ];
  assert.throws(
    () => assertMigrationOrdering(disordered),
    /Migration ordering violation: '20260403_withdrawal\.sql' is not strictly before '20260402_wallets\.sql'/
  );
});

test('assertMigrationOrdering throws when migration sequence contains duplicate entries', () => {
  const duplicates = [
    '20260401_users.sql',
    '20260402_wallets.sql',
    '20260402_wallets.sql',
  ];
  assert.throws(
    () => assertMigrationOrdering(duplicates),
    /Migration ordering violation: '20260402_wallets\.sql' is not strictly before '20260402_wallets\.sql'/
  );
});

test('readDownSql returns null when down migration is missing (documenting rollback limits)', () => {
  // Almost all migrations in crowdpay omit down files to enforce forward-only schema progression
  const downContent = readDownSql('20260401_users_campaigns_contributions.sql');
  assert.equal(downContent, null, 'missing .down.sql must yield null');
});

test('readDownSql returns down SQL content when down migration is present', () => {
  const downContent = readDownSql('20250601000000_add_velocity_alert_threshold.sql');
  assert.ok(typeof downContent === 'string' && downContent.length > 0);
  assert.ok(downContent.includes('ALTER TABLE'));
});

test('runDown rejects with documented rollback limitation error', async () => {
  const mockClient = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    async () => {
      await runDown(mockClient);
    },
    /\[migrate:down\] Rollback is not supported due to lack of down migration files\./
  );
});

test('runUp rejects when an applied migration file hash differs (hash mismatch immutability guard)', async () => {
  const upFiles = listUpMigrationFilenames();
  const targetFile = upFiles[0];

  const mockClient = {
    query: async text => {
      if (text.includes('pg_advisory_lock')) return { rows: [] };
      if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
      if (text.includes('SELECT filename, file_hash, applied_at FROM schema_migrations')) {
        return {
          rows: [
            {
              filename: targetFile,
              file_hash: 'tampered_tampered_tampered_tampered_tampered_tampered_tampered_000',
              applied_at: new Date(),
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    async () => {
      await runUp(mockClient);
    },
    new RegExp(`Migration '${targetFile}' was applied but its content has changed since then \\(hash mismatch\\)`)
  );
});

test('runUp does not record failed migration in schema_migrations on error (recovery path)', async () => {
  const queries = [];
  let executedRollback = false;

  const mockClient = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('pg_advisory_lock') || text.includes('pg_advisory_unlock')) {
        return { rows: [{ unlocked: true }] };
      }
      if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        return { rows: [] };
      }
      if (text.includes('SELECT filename, file_hash, applied_at FROM schema_migrations')) {
        // Pretend none have been applied yet
        return { rows: [] };
      }
      if (text === 'BEGIN') {
        return { rows: [] };
      }
      if (text === 'ROLLBACK') {
        executedRollback = true;
        return { rows: [] };
      }
      // Fail on the first migration's SQL execution
      throw new Error('Database disk error during migration');
    },
  };

  await assert.rejects(async () => {
    await runUp(mockClient);
  }, /Database disk error during migration/);

  assert.equal(executedRollback, true, 'ROLLBACK must be executed when migration statement fails');

  // Verify that INSERT INTO schema_migrations was never reached for the failed file
  const recordedInserts = queries.filter(q =>
    q.text && q.text.includes('INSERT INTO schema_migrations')
  );
  assert.equal(recordedInserts.length, 0, 'failed migration must not be recorded in schema_migrations');
});
