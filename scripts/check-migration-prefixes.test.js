'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkMigrationPrefixes, prefixOf } = require('./check-migration-prefixes');

const LEGACY = ['20260401_users.sql', '20261020_a.sql', '20261020_b.sql', '20261124_last.sql'];

test('prefixOf extracts only 14-digit timestamp prefixes', () => {
  assert.equal(prefixOf('20261125093015_add_widget.sql'), '20261125093015');
  assert.equal(prefixOf('20261125_add_widget.sql'), null);
  assert.equal(prefixOf('add_widget.sql'), null);
});

test('grandfathered duplicate date prefixes are allowed', () => {
  assert.deepEqual(checkMigrationPrefixes(LEGACY, LEGACY), []);
});

test('a new migration with a unique timestamp prefix passes', () => {
  assert.deepEqual(
    checkMigrationPrefixes([...LEGACY, '20261125093015_add_widget.sql'], LEGACY),
    []
  );
});

test('a new up and down pair sharing one prefix passes', () => {
  const files = [...LEGACY, '20261125093015_add_widget.sql', '20261125093015_add_widget.down.sql'];
  assert.deepEqual(checkMigrationPrefixes(files, LEGACY), []);
});

test('rejects a new migration with only a YYYYMMDD prefix', () => {
  const problems = checkMigrationPrefixes([...LEGACY, '20261125_add_widget.sql'], LEGACY);
  assert.deepEqual(problems, [
    '20261125_add_widget.sql: new migrations must start with a 14-digit YYYYMMDDHHMMSS_ prefix',
  ]);
});

test('rejects two new migrations that share a timestamp prefix', () => {
  const files = [...LEGACY, '20261125093015_a.sql', '20261125093015_b.sql'];
  const problems = checkMigrationPrefixes(files, LEGACY);
  assert.equal(problems.length, 2);
  assert.match(
    problems[0],
    /20261125093015_a\.sql: prefix 20261125093015 is also used by 20261125093015_b$/
  );
  assert.match(
    problems[1],
    /20261125093015_b\.sql: prefix 20261125093015 is also used by 20261125093015_a$/
  );
});

test('rejects a new migration reusing a legacy 14-digit prefix', () => {
  const legacy = [...LEGACY, '20250601000000_old.sql'];
  const problems = checkMigrationPrefixes([...legacy, '20250601000000_new.sql'], legacy);
  assert.ok(
    problems.some(p => p.includes('prefix 20250601000000 is also used by 20250601000000_old'))
  );
});

test('rejects a new migration that would sort before the last existing one', () => {
  const problems = checkMigrationPrefixes([...LEGACY, '20260101000000_backdated.sql'], LEGACY);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /sorts before or equal to the last existing migration 20261124_last\.sql/
  );
});

test('a same-day timestamp still sorts after the legacy date-only file', () => {
  // '0' < '_' in ASCII, so 20261124000000_x would sort BEFORE 20261124_last.sql.
  const before = checkMigrationPrefixes([...LEGACY, '20261124000000_x.sql'], LEGACY);
  assert.equal(before.length, 1);
  const after = checkMigrationPrefixes([...LEGACY, '20261125000000_x.sql'], LEGACY);
  assert.deepEqual(after, []);
});

test('rejects non-.sql files that are not grandfathered', () => {
  const problems = checkMigrationPrefixes([...LEGACY, '20261125093015_notes.txt'], LEGACY);
  assert.deepEqual(problems, ['20261125093015_notes.txt: migrations must be .sql files']);
});

test('ignores dotfiles such as .gitkeep', () => {
  assert.deepEqual(checkMigrationPrefixes([...LEGACY, '.gitkeep'], LEGACY), []);
});

test('the real migrations directory passes against the committed baseline', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'check-migration-prefixes.js')],
    {
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[migration-prefixes\] OK/);
});

test('CLI exits 1 and explains the naming rule when a bad file is added', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  const baseline = path.join(dir, 'baseline.json');
  fs.writeFileSync(baseline, JSON.stringify({ legacy: ['20260401_users.sql'] }));
  fs.writeFileSync(path.join(dir, '20260401_users.sql'), '');
  fs.writeFileSync(path.join(dir, '20261125_oops.sql'), '');
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'check-migration-prefixes.js'), '--dir', dir, '--baseline', baseline],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[migration-prefixes\] FAILED/);
  assert.match(result.stderr, /20261125_oops\.sql/);
  assert.match(result.stderr, /YYYYMMDDHHMMSS/);
});
