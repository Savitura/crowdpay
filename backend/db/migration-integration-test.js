'use strict';

/**
 * Upgrade a committed, production-like snapshot in an isolated database.
 * The database is created and dropped for this process, so CI runs never
 * share state with the normal migration or application test database.
 *
 * It then asserts that db/schema.sql and the migration set converge (#1270):
 * one disposable database is bootstrapped from schema.sql plus
 * `migrate.js up --bootstrap-schema`, another is built from an empty database
 * with `migrate.js up`, and their normalized public schemas must be identical.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Pool } = require('pg');
const { listUpMigrationFilenames } = require('./migrateLib');

const execFileAsync = promisify(execFile);
const BACKEND_ROOT = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'production-like-20260404.sql');
const schemaPath = path.join(__dirname, 'schema.sql');
const MIGRATIONS_TABLE = 'schema_migrations';

function databaseUrlWithName(source, name) {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runMigrations(databaseUrl, extraArgs = []) {
  await execFileAsync(process.execPath, ['db/migrate.js', 'up', ...extraArgs], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Read the structural snapshot of the public schema: columns, indexes and
 * constraints. Bookkeeping tables owned by the migration runner are excluded
 * because they only exist on the migrations path.
 */
async function readSchemaSnapshot(pool) {
  const { rows: columns } = await pool.query(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name <> '${MIGRATIONS_TABLE}'
     ORDER BY table_name, column_name
  `);

  const { rows: indexes } = await pool.query(`
    SELECT tablename AS table_name, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename <> '${MIGRATIONS_TABLE}'
       AND indexname NOT LIKE '%${MIGRATIONS_TABLE}%'
     ORDER BY tablename, indexdef
  `);

  const { rows: constraints } = await pool.query(`
    SELECT conrelid::regclass::text AS table_name, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
       AND conrelid::regclass::text <> '${MIGRATIONS_TABLE}'
     ORDER BY 1, 2, 3
  `);

  return { columns, indexes, constraints };
}

/**
 * schema.sql and the migrations historically give equivalent objects different
 * names (e.g. `idx_campaigns_creator_id` vs `campaigns_creator_id_idx`), so
 * indexes are compared by table + definition and constraints by
 * table + type + definition. Definitions still have to match exactly.
 */
function normalizeIndexName(indexdef) {
  return indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, (_match, unique) => {
    return `CREATE ${unique || ''}INDEX ON `;
  });
}

function columnKey(row) {
  return `${row.table_name}.${row.column_name}`;
}

function describeColumn(row) {
  return `${row.data_type}${row.is_nullable === 'NO' ? ' NOT NULL' : ''}${
    row.column_default ? ` DEFAULT ${row.column_default}` : ''
  }`;
}

function compareSchemaSnapshots(bootstrap, migrationsOnly) {
  const failures = [];

  const bootstrapColumns = new Map(bootstrap.columns.map(row => [columnKey(row), row]));
  const migrationsColumns = new Map(migrationsOnly.columns.map(row => [columnKey(row), row]));
  for (const [key, row] of bootstrapColumns) {
    const other = migrationsColumns.get(key);
    if (!other) {
      failures.push(`column '${key}' is created by schema.sql but not by the migrations`);
      continue;
    }
    if (
      row.data_type !== other.data_type ||
      row.udt_name !== other.udt_name ||
      row.is_nullable !== other.is_nullable ||
      row.column_default !== other.column_default
    ) {
      failures.push(
        `column '${key}' differs: schema.sql bootstrap has ${describeColumn(row)}, ` +
          `migrations-only has ${describeColumn(other)}`
      );
    }
  }
  for (const key of migrationsColumns.keys()) {
    if (!bootstrapColumns.has(key)) {
      failures.push(`column '${key}' is created by the migrations but missing after schema.sql`);
    }
  }

  const diffNames = (label, bootstrapRows, migrationRows, normalize) => {
    const left = new Set(bootstrapRows.map(normalize));
    const right = new Set(migrationRows.map(normalize));
    for (const value of left) {
      if (!right.has(value)) {
        failures.push(`${label} only in the schema.sql bootstrap: ${value}`);
      }
    }
    for (const value of right) {
      if (!left.has(value)) {
        failures.push(`${label} only in a migrations-only database: ${value}`);
      }
    }
  };

  diffNames(
    'index',
    bootstrap.indexes,
    migrationsOnly.indexes,
    row => `${row.table_name}: ${normalizeIndexName(row.indexdef)}`
  );
  diffNames(
    'constraint',
    bootstrap.constraints,
    migrationsOnly.constraints,
    row => `${row.table_name} (${row.contype}): ${row.definition}`
  );

  return failures;
}

/**
 * Confirm that the two supported bootstrap paths end in the same schema:
 *   schema.sql + `migrate.js up --bootstrap-schema`
 *   empty database + `migrate.js up`
 */
async function verifySchemaConvergence(sourceUrl) {
  const adminUrl = databaseUrlWithName(sourceUrl, 'postgres');
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const bootstrapName = `crowdpay_schema_${suffix}`;
  const migrationsName = `crowdpay_migrations_${suffix}`;
  const bootstrapUrl = databaseUrlWithName(sourceUrl, bootstrapName);
  const migrationsUrl = databaseUrlWithName(sourceUrl, migrationsName);
  const adminPool = new Pool({ connectionString: adminUrl });
  let bootstrapPool;
  let migrationsPool;

  try {
    await adminPool.query(`CREATE DATABASE "${bootstrapName}"`);
    await adminPool.query(`CREATE DATABASE "${migrationsName}"`);

    bootstrapPool = new Pool({ connectionString: bootstrapUrl });
    await bootstrapPool.query(fs.readFileSync(schemaPath, 'utf8'));
    await runMigrations(bootstrapUrl, ['--bootstrap-schema']);

    await runMigrations(migrationsUrl);
    migrationsPool = new Pool({ connectionString: migrationsUrl });

    const bootstrap = await readSchemaSnapshot(bootstrapPool);
    const migrationsOnly = await readSchemaSnapshot(migrationsPool);
    const failures = compareSchemaSnapshots(bootstrap, migrationsOnly);

    if (failures.length) {
      throw new Error(
        `schema.sql and the migration set have drifted (${failures.length} difference(s)):\n` +
          failures.map(failure => `  - ${failure}`).join('\n')
      );
    }

    console.log(
      '[migration-integration] OK: schema.sql bootstrap and the migration set converge ' +
        `(${bootstrap.columns.length} columns, ${bootstrap.indexes.length} indexes, ` +
        `${bootstrap.constraints.length} constraints).`
    );
  } finally {
    if (bootstrapPool) await bootstrapPool.end();
    if (migrationsPool) await migrationsPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${bootstrapName}" WITH (FORCE)`);
    await adminPool.query(`DROP DATABASE IF EXISTS "${migrationsName}" WITH (FORCE)`);
    await adminPool.end();
  }
}

async function verifyFixtureUpgrade(sourceUrl) {
  const databaseName = `crowdpay_migration_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = databaseUrlWithName(sourceUrl, 'postgres');
  const targetUrl = databaseUrlWithName(sourceUrl, databaseName);
  const adminPool = new Pool({ connectionString: adminUrl });
  let targetPool;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    targetPool = new Pool({ connectionString: targetUrl });
    await targetPool.query(fs.readFileSync(fixturePath, 'utf8'));

    await runMigrations(targetUrl);

    const { rows: counts } = await targetPool.query(`
      SELECT
        (SELECT COUNT(*) FROM campaigns WHERE id = '00000000-0000-0000-0000-000000000010') AS campaigns,
        (SELECT COUNT(*) FROM contributions WHERE id = '00000000-0000-0000-0000-000000000020' AND tx_hash = 'fixture-contribution-tx') AS contributions,
        (SELECT COUNT(*) FROM withdrawal_requests WHERE id = '00000000-0000-0000-0000-000000000030') AS payouts
    `);
    const countsRow = counts[0];
    if (
      countsRow.campaigns !== '1' ||
      countsRow.contributions !== '1' ||
      countsRow.payouts !== '1'
    ) {
      throw new Error(`Fixture records were not preserved: ${JSON.stringify(countsRow)}`);
    }

    const { rows: migrationRows } = await targetPool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    if (migrationRows.length !== listUpMigrationFilenames().length) {
      throw new Error(
        `Migration runner did not apply the complete set: ${migrationRows.length}/${listUpMigrationFilenames().length}`
      );
    }

    const { rows: indexes } = await targetPool.query(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_contributions_campaign_id', 'stellar_transactions_campaign_created_idx', 'ledger_stream_alerts_campaign_idx')
    `);
    if (indexes.length !== 3) throw new Error('Required upgrade indexes are missing');

    const { rows: constraints } = await targetPool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND ((table_name = 'campaigns' AND constraint_type = 'CHECK')
           OR (table_name = 'contributions' AND constraint_type = 'UNIQUE')
           OR (table_name = 'withdrawal_requests' AND constraint_type = 'CHECK'))
    `);
    if (constraints.length < 3) throw new Error('Required upgrade constraints are missing');

    console.log(
      '[migration-integration] OK: fixture upgraded with records, indexes, and constraints intact.'
    );
  } finally {
    if (targetPool) await targetPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  }
}

async function main() {
  const sourceUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/postgres';
  await verifyFixtureUpgrade(sourceUrl);
  await verifySchemaConvergence(sourceUrl);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[migration-integration] FAILED:', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  compareSchemaSnapshots,
  normalizeIndexName,
  readSchemaSnapshot,
  verifySchemaConvergence,
};
