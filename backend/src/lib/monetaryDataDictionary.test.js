'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MONETARY_COLUMNS,
  getMonetaryColumn,
  hasMonetaryColumn,
  listMonetaryColumns,
  listMonetaryTables,
  validateMonetaryValue,
} = require('./monetaryDataDictionary');

test('data dictionary registers all required metadata on every entry', () => {
  const columns = listMonetaryColumns();
  assert.ok(columns.length > 30, 'Should have registered all primary monetary columns');

  for (const col of columns) {
    assert.ok(col.tableName, `Missing tableName for ${col.tableName}.${col.columnName}`);
    assert.ok(col.columnName, `Missing columnName for ${col.tableName}.${col.columnName}`);
    assert.ok(col.dataType, `Missing dataType for ${col.tableName}.${col.columnName}`);
    assert.ok(col.unit, `Missing unit for ${col.tableName}.${col.columnName}`);
    assert.ok(typeof col.stroopAligned === 'boolean', `stroopAligned must be boolean for ${col.tableName}.${col.columnName}`);
    assert.ok(typeof col.isNullable === 'boolean', `isNullable must be boolean for ${col.tableName}.${col.columnName}`);
    assert.ok(col.description, `Missing description for ${col.tableName}.${col.columnName}`);
    assert.ok(col.roundingRule, `Missing roundingRule for ${col.tableName}.${col.columnName}`);
  }
});

test('getMonetaryColumn retrieves known columns and handles case-insensitivity and trimming', () => {
  const targetCol = getMonetaryColumn('campaigns', 'target_amount');
  assert.ok(targetCol);
  assert.equal(targetCol.tableName, 'campaigns');
  assert.equal(targetCol.columnName, 'target_amount');
  assert.equal(targetCol.dataType, 'NUMERIC(20, 7)');
  assert.equal(targetCol.stroopAligned, true);
  assert.equal(targetCol.scale, 7);

  // Case insensitivity
  assert.deepEqual(getMonetaryColumn('CAMPAIGNS', 'TARGET_AMOUNT'), targetCol);
  assert.deepEqual(getMonetaryColumn('  campaigns  ', '  target_amount  '), targetCol);

  // Contributions amount
  const contribCol = getMonetaryColumn('contributions', 'amount');
  assert.ok(contribCol);
  assert.equal(contribCol.pairedAssetColumn, 'asset');
  assert.equal(contribCol.stroopAligned, true);
});

test('listMonetaryTables returns sorted list of unique table names', () => {
  const tables = listMonetaryTables();
  assert.ok(tables.includes('campaigns'));
  assert.ok(tables.includes('contributions'));
  assert.ok(tables.includes('withdrawal_requests'));
  assert.ok(tables.includes('subscriptions'));
  assert.ok(tables.includes('milestones'));

  // Ensure sorted and unique
  const sorted = [...tables].sort();
  assert.deepEqual(tables, sorted);
  assert.equal(new Set(tables).size, tables.length);
});

test('listMonetaryColumns supports filtering by stroopOnly and tableName', () => {
  const stroopCols = listMonetaryColumns({ stroopOnly: true });
  for (const c of stroopCols) {
    assert.equal(c.stroopAligned, true);
  }

  const campaignCols = listMonetaryColumns({ tableName: 'campaigns' });
  for (const c of campaignCols) {
    assert.equal(c.tableName, 'campaigns');
  }
  assert.ok(campaignCols.some(c => c.columnName === 'target_amount'));
  assert.ok(campaignCols.some(c => c.columnName === 'raised_amount'));
});

test('validateMonetaryValue primary path validates valid monetary values', () => {
  // campaigns.target_amount
  const res1 = validateMonetaryValue('campaigns', 'target_amount', '100.5000000');
  assert.equal(res1.valid, true);
  assert.equal(res1.stroops, 1005000000n);

  // contributions.amount
  const res2 = validateMonetaryValue('contributions', 'amount', '5');
  assert.equal(res2.valid, true);
  assert.equal(res2.stroops, 50000000n);

  // 1 stroop (0.0000001)
  const res3 = validateMonetaryValue('contributions', 'amount', '0.0000001');
  assert.equal(res3.valid, true);
  assert.equal(res3.stroops, 1n);

  // integer basis points
  const resBps = validateMonetaryValue('campaigns', 'platform_fee_bps', 250);
  assert.equal(resBps.valid, true);

  // release_percentage (up to 4 decimals)
  const resPct = validateMonetaryValue('milestones', 'release_percentage', '33.3333');
  assert.equal(resPct.valid, true);
});

test('validateMonetaryValue edge/failure case: rejects non-registered columns', () => {
  assert.equal(hasMonetaryColumn('non_existent', 'col'), false);
  const res = validateMonetaryValue('non_existent', 'col', '100');
  assert.equal(res.valid, false);
  assert.match(res.error, /not a registered monetary column/);
});

test('validateMonetaryValue edge/failure case: rejects values exceeding 7 decimal places for stroop columns', () => {
  // 8 decimal places: '1.00000001'
  const res = validateMonetaryValue('campaigns', 'target_amount', '1.00000001');
  assert.equal(res.valid, false);
  assert.match(res.error, /(?:more than|exceeds) 7 decimal places/i);
});

test('validateMonetaryValue edge/failure case: rejects negative numbers and invalid numbers', () => {
  const resNegative = validateMonetaryValue('campaigns', 'target_amount', '-10');
  assert.equal(resNegative.valid, false);

  const resInvalid = validateMonetaryValue('campaigns', 'target_amount', 'not_a_number');
  assert.equal(resInvalid.valid, false);

  const resEmpty = validateMonetaryValue('campaigns', 'target_amount', '');
  assert.equal(resEmpty.valid, false);
});

test('validateMonetaryValue edge/failure case: zero handling for strictly positive vs zero-allowed columns', () => {
  // target_amount must be > 0
  const resZeroTarget = validateMonetaryValue('campaigns', 'target_amount', '0');
  assert.equal(resZeroTarget.valid, false);

  // raised_amount allows 0
  const resZeroRaised = validateMonetaryValue('campaigns', 'raised_amount', '0');
  assert.equal(resZeroRaised.valid, true);
  assert.equal(resZeroRaised.stroops, 0n);
});

test('validateMonetaryValue edge/failure case: null handling for non-nullable vs nullable columns', () => {
  // target_amount cannot be null
  const resNullTarget = validateMonetaryValue('campaigns', 'target_amount', null);
  assert.equal(resNullTarget.valid, false);
  assert.match(resNullTarget.error, /cannot be null/);

  // min_contribution is nullable
  const resNullMin = validateMonetaryValue('campaigns', 'min_contribution', null);
  assert.equal(resNullMin.valid, true);
});

test('validateMonetaryValue edge/failure case: percentage and bps upper bounds', () => {
  // milestone release percentage > 100
  const resHighPct = validateMonetaryValue('milestones', 'release_percentage', '100.0001');
  assert.equal(resHighPct.valid, false);

  // platform_fee_bps > 10000 (100%)
  const resHighBps = validateMonetaryValue('campaigns', 'platform_fee_bps', 10001);
  assert.equal(resHighBps.valid, false);
});

test('schema convergence check: every NUMERIC(20, 7) column in schema.sql is documented in data dictionary', () => {
  const schemaPath = path.resolve(__dirname, '../../../backend/db/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Regex to extract table definitions and NUMERIC(20, 7) columns
  const tableRegex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
  let tableMatch;

  const foundSchemaColumns = [];
  while ((tableMatch = tableRegex.exec(schemaSql)) !== null) {
    const tableName = tableMatch[1].toLowerCase();
    const body = tableMatch[2];
    const lines = body.split('\n');
    for (const line of lines) {
      const colMatch = line.trim().match(/^([a-zA-Z0-9_]+)\s+NUMERIC\s*\(\s*20\s*,\s*7\s*\)/i);
      if (colMatch) {
        const colName = colMatch[1].toLowerCase();
        foundSchemaColumns.push({ tableName, columnName: colName });
      }
    }
  }

  assert.ok(foundSchemaColumns.length > 10, 'Found NUMERIC(20, 7) columns in schema.sql');
  for (const { tableName, columnName } of foundSchemaColumns) {
    assert.ok(
      hasMonetaryColumn(tableName, columnName),
      `Column ${tableName}.${columnName} in schema.sql must be cataloged in monetaryDataDictionary`
    );
  }
});
