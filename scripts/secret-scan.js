#!/usr/bin/env node
'use strict';
/**
 * Dependency-free secret scanner for CI (issue #1131).
 * Usage: node scripts/secret-scan.js [--tracked]   (scans `git ls-files`)
 *        node scripts/secret-scan.js <file...>
 * Findings never print the secret value, only file:line and rule name.
 * Suppress a reviewed false positive with a `secret-scan:allow` comment on the
 * same line, or a path entry in .secret-scan-allowlist (one path prefix or `*` glob
 * per line, # comments allowed).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RULES = [
  { name: 'Stellar secret seed', re: /\bS[A-Z2-7]{55}\b/ },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe live key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];
const ALLOW_MARKER = 'secret-scan:allow';
const MAX_BYTES = 1024 * 1024;

function scanText(text, file = '<input>') {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ file, line: i + 1, rule: rule.name });
    }
  });
  return findings;
}

function loadAllowlist(root) {
  const p = path.join(root, '.secret-scan-allowlist');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

function isAllowed(file, allowlist) {
  const f = file.replace(/\\/g, '/');
  return allowlist.some((entry) => {
    if (!entry.includes('*')) return f === entry || f.startsWith(entry);
    const re = new RegExp('^' + entry.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(f);
  });
}

function scanFiles(files, root, allowlist = []) {
  const findings = [];
  for (const file of files) {
    if (isAllowed(file, allowlist)) continue;
    const abs = path.join(root, file);
    let buf;
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    findings.push(...scanText(buf.toString('utf8'), file));
  }
  return findings;
}

function main(argv) {
  const root = path.resolve(__dirname, '..');
  const args = argv.filter((a) => a !== '--tracked');
  const files = args.length
    ? args
    : execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const findings = scanFiles(files, root, loadAllowlist(root));
  if (findings.length) {
    console.error('\n  SECRET SCAN FAILED - possible credentials committed:\n');
    findings.forEach((f) => console.error(`      ${f.file}:${f.line}  ${f.rule}`));
    console.error(
      '\n  Remove the value, rotate it if it was ever real, and load it from the secret' +
        '\n  manager. For a reviewed false positive add `secret-scan:allow` on the line.\n'
    );
    return 1;
  }
  console.log(`secret-scan: ${files.length} files clean`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scanText, scanFiles, isAllowed, RULES };
