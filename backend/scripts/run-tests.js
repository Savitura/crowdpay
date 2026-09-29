#!/usr/bin/env node
/**
 * run-tests.js
 *
 * Recursively discovers every *.test.js file under src/ and runs them with
 * the built-in Node test runner (node:test). This replaces the shell-glob
 * approach in the "test" npm script, which failed to traverse nested
 * directories (e.g. src/services/ops/) on both Windows cmd and standard
 * bash (globstar is off by default).
 *
 * Usage: node scripts/run-tests.js
 *
 * Respects the same environment variables as the previous test command:
 *   --test-force-exit  → passed via run() options
 *   --test-timeout     → passed via run() options
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || 'CAQCFV4CS2CW6TD57ZUH77Z772427P5UTME5QLNUBK6M5M74FY6ZEX7B';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';
process.env.PLATFORM_SECRET_KEY = process.env.PLATFORM_SECRET_KEY || 'SDVGKOWW4WCVJ7GZ47S77GZGL2PZ67HQVCS475S2F3DFV2GOH63QW34Z';
process.env.PLATFORM_APPROVER_USER_ID = process.env.PLATFORM_APPROVER_USER_ID || 'platform-admin-1';
process.env.WORKER_ENABLED = 'false';

const { run } = require('node:test');
const { spec: SpecReporter } = require('node:test/reporters');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', 'src');
const TEST_FILE_PATTERN = /\.test\.js$/;
const TIMEOUT_MS = 30_000;

/**
 * Recursively collect all *.test.js files under a directory.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function collectTestFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = collectTestFiles(ROOT);

if (files.length === 0) {
  console.error('No test files found under', ROOT);
  process.exitCode = 1;
} else {
  // Print discovered files so CI logs show what ran.
  console.log(`Discovered ${files.length} test file(s):\n` + files.map((f) => `  ${f}`).join('\n'));

  const stream = run({
    files,
    timeout: TIMEOUT_MS,
    forceExit: true,
    concurrency: true,
  });

  // Pipe through the built-in spec (tap-like) reporter.
  stream.compose(new SpecReporter()).pipe(process.stdout);

  // Propagate non-zero exit on test failure.
  stream.on('test:fail', () => {
    process.exitCode = 1;
  });
}
