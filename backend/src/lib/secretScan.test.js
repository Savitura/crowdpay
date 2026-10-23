'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanText, scanFiles, isAllowed } = require('../../../scripts/secret-scan');

// Built at runtime so this file never contains a literal secret-shaped string.
const fakeSeed = 'S' + 'A'.repeat(55);
const fakeAws = 'AKIA' + 'B'.repeat(16);

test('flags a Stellar secret seed without echoing the value', () => {
  const f = scanText(`KEY=${fakeSeed}\n`, 'a.js');
  assert.deepEqual(f, [{ file: 'a.js', line: 1, rule: 'Stellar secret seed' }]);
  assert.ok(!JSON.stringify(f).includes(fakeSeed));
});

test('flags AWS keys and private key blocks', () => {
  const f = scanText(`x=${fakeAws}\n-----BEGIN RSA PRIVATE KEY-----`);
  assert.deepEqual(f.map((x) => x.rule), ['AWS access key id', 'Private key block']);
});

test('clean text and allow-marked lines produce no findings', () => {
  assert.deepEqual(scanText('const a = 1;\nSTELLAR_NETWORK=testnet'), []);
  assert.deepEqual(scanText(`k=${fakeSeed} // secret-scan:allow test fixture`), []);
});

test('scanFiles honours allowlist and skips binary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  fs.writeFileSync(path.join(dir, 'bad.txt'), fakeSeed);
  fs.writeFileSync(path.join(dir, 'ok.bin'), Buffer.from([0, 1, 2]));
  assert.equal(scanFiles(['bad.txt', 'ok.bin'], dir).length, 1);
  assert.equal(scanFiles(['bad.txt'], dir, ['bad.txt']).length, 0);
  assert.ok(isAllowed('docs\\x.md', ['docs/']));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allowlist supports * globs', () => {
  assert.ok(isAllowed('backend/src/a/b.test.js', ['backend/src/**/*.test.js']));
  assert.ok(!isAllowed('backend/src/a/b.js', ['backend/src/**/*.test.js']));
});
