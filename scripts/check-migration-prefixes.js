#!/usr/bin/env node
/**
 * Enforce unique, timestamped filename prefixes for new migrations in
 * backend/db/migrations/ (#1316).
 *
 * Migrations run in filename order. Legacy files only carry a YYYYMMDD_ date,
 * so several share a prefix and rely on alphabetical tie-breaking. Renaming
 * already-applied migrations would change their recorded names, so those files
 * are grandfathered in scripts/migration-prefix-baseline.json. Every other
 * file must:
 *
 *   1. start with a 14-digit YYYYMMDDHHMMSS_ prefix,
 *   2. use a prefix no other migration uses (an `.sql` and its `.down.sql`
 *      share one prefix), and
 *   3. sort after every grandfathered migration, so new files always run last.
 *
 * Usage: node scripts/check-migration-prefixes.js [--dir <path>] [--baseline <file>]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const DEFAULT_BASELINE = path.join(__dirname, 'migration-prefix-baseline.json');
const TIMESTAMP_PREFIX = /^(\d{14})_/;

function prefixOf(filename) {
  const match = TIMESTAMP_PREFIX.exec(filename);
  return match ? match[1] : null;
}

function baseNameOf(filename) {
  return filename.replace(/(\.down)?\.sql$/, '');
}

/** Returns a list of human-readable problems; empty means the check passes. */
function checkMigrationPrefixes(filenames, legacyFilenames) {
  const problems = [];
  const legacy = new Set(legacyFilenames);
  const files = filenames.filter(f => !f.startsWith('.')).sort();
  const fresh = files.filter(f => !legacy.has(f));
  const lastLegacy = [...legacy].sort().pop() || '';

  for (const name of fresh) {
    if (!name.endsWith('.sql')) {
      problems.push(`${name}: migrations must be .sql files`);
      continue;
    }
    if (!prefixOf(name)) {
      problems.push(`${name}: new migrations must start with a 14-digit YYYYMMDDHHMMSS_ prefix`);
    }
  }

  // An up migration and its down file share one prefix; anything else colliding is a clash.
  const owners = new Map();
  for (const name of files) {
    const prefix = prefixOf(name);
    if (!prefix) continue;
    const base = baseNameOf(name);
    const owner = owners.get(prefix);
    if (owner === undefined) owners.set(prefix, new Set([base]));
    else owner.add(base);
  }
  for (const name of fresh) {
    const prefix = prefixOf(name);
    if (!prefix) continue;
    const bases = owners.get(prefix);
    if (bases.size > 1) {
      const others = [...bases].filter(b => b !== baseNameOf(name));
      problems.push(`${name}: prefix ${prefix} is also used by ${others.join(', ')}`);
    }
  }

  for (const name of fresh) {
    if (prefixOf(name) && name <= lastLegacy) {
      problems.push(
        `${name}: sorts before or equal to the last existing migration ${lastLegacy}; use a newer timestamp`
      );
    }
  }

  return [...new Set(problems)];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir || DEFAULT_DIR;
  const baselinePath = args.baseline || DEFAULT_BASELINE;
  const legacy = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).legacy;
  const problems = checkMigrationPrefixes(fs.readdirSync(dir), legacy);

  if (problems.length) {
    console.error('[migration-prefixes] FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nName new migrations like 20261125093015_add_widget.sql (UTC YYYYMMDDHHMMSS_) so ' +
        'ordering never depends on alphabetical tie-breaking.'
    );
    process.exit(1);
  }
  console.log('[migration-prefixes] OK');
}

if (require.main === module) main();

module.exports = { checkMigrationPrefixes, prefixOf };
