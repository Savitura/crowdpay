// Keeps the local development instructions runnable: every npm script that the
// README and CONTRIBUTING tell people to run must exist in the package the
// command runs in (#1119).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const SCRIPTS = {
  '.': JSON.parse(readRepoFile('package.json')).scripts,
  backend: JSON.parse(readRepoFile('backend/package.json')).scripts,
  frontend: JSON.parse(readRepoFile('frontend/package.json')).scripts,
};

function packageDir(target) {
  const name = path.basename(target);
  return name === 'backend' || name === 'frontend' ? name : '.';
}

// Text from a heading to the next heading of the same or a higher level.
// Lines inside fenced code blocks are never headings (shell comments).
function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const level = heading.indexOf(' ');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('```')) inFence = !inFence;
    const match = inFence ? null : /^(#+) /.exec(lines[i]);
    if (!match) continue;
    if (start === -1) {
      if (lines[i].trim() === heading) start = i;
    } else if (match[1].length <= level) {
      end = i;
      break;
    }
  }
  assert.notEqual(start, -1, `heading "${heading}" not found`);
  return lines.slice(start, end).join('\n');
}

// `npm run <script>`, `npm start` or `npm test`, run in `cwd` unless the
// command names another package with `--prefix`.
function parseNpmCommand(command, cwd) {
  const match = /^npm\s+(?:run\s+([\w:.-]+)|(start|test)\b)(.*)$/.exec(command);
  if (!match) return null;
  const prefix = /--prefix\s+(\S+)/.exec(match[3]);
  return { dir: prefix ? packageDir(prefix[1]) : cwd, script: match[1] || match[2] };
}

// npm commands in fenced code blocks. `cd backend`, `cd ../frontend` and
// `cd ..` move between packages; each block starts at the repository root.
function fencedNpmCommands(markdown) {
  const found = [];
  let inFence = false;
  let cwd = '.';
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      cwd = '.';
      continue;
    }
    if (!inFence) continue;
    for (const part of line.replace(/#.*$/, '').split(/&&|;/)) {
      const command = part.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
      const cd = /^cd\s+(\S+)$/.exec(command);
      if (cd) {
        cwd = packageDir(cd[1]);
        continue;
      }
      const parsed = parseNpmCommand(command, cwd);
      if (parsed) found.push(parsed);
    }
  }
  return found;
}

// npm commands in inline code, all run in `dir` (the script tables).
function inlineNpmCommands(markdown, dir) {
  const found = [];
  for (const [, code] of markdown.matchAll(/`([^`\n]+)`/g)) {
    const parsed = parseNpmCommand(code.trim(), dir);
    if (parsed) found.push(parsed);
  }
  return found;
}

function missingScripts(commands) {
  return commands
    .filter(({ dir, script }) => !Object.hasOwn(SCRIPTS[dir] || {}, script))
    .map(({ dir, script }) => `${dir}: npm run ${script}`);
}

test('the README quick start only runs scripts that exist', () => {
  const commands = fencedNpmCommands(section(readRepoFile('README.md'), '## Quick Start'));
  const backendScripts = commands.filter(c => c.dir === 'backend').map(c => c.script);

  assert.ok(backendScripts.includes('dev'), 'the web server command is documented');
  assert.ok(backendScripts.includes('dev:worker'), 'the worker command is documented');
  assert.deepEqual(missingScripts(commands), []);
});

test('the CONTRIBUTING quick setup only runs scripts that exist', () => {
  const commands = fencedNpmCommands(section(readRepoFile('CONTRIBUTING.md'), '## Quick Setup'));

  assert.ok(commands.length > 0);
  assert.deepEqual(missingScripts(commands), []);
});

test('the README script tables only list scripts that exist', () => {
  const scripts = section(readRepoFile('README.md'), '## Available Scripts');
  const commands = [
    ...inlineNpmCommands(section(scripts, '### Root (repo level)'), '.'),
    ...inlineNpmCommands(section(scripts, '### Backend'), 'backend'),
    ...inlineNpmCommands(section(scripts, '### Frontend'), 'frontend'),
  ];

  assert.ok(commands.some(c => c.dir === 'backend' && c.script === 'worker'));
  assert.deepEqual(missingScripts(commands), []);
});

test('the worker compose override runs a backend script and keeps the jobs out of the API', () => {
  const override = readRepoFile('docker-compose.worker.yml');
  const command = /^\s+command:\s*(.+)$/m.exec(override);

  assert.ok(command, 'the worker service has a command');
  const parsed = parseNpmCommand(command[1].trim(), 'backend');
  assert.ok(parsed, 'the worker command is an npm script');
  assert.deepEqual(missingScripts([parsed]), []);
  assert.match(override, /^\s+WORKER_ENABLED:\s*"false"$/m);
});

test('a documented script that the package does not define is reported', () => {
  const doc = [
    '```bash',
    'cd backend && npm run dev',
    'WORKER_ENABLED=false npm run serve',
    'cd ../frontend && npm test',
    'npm run lint --prefix backend',
    '```',
    '',
    '```bash',
    'npm run test:e2e',
    'npm run build',
    '```',
  ].join('\n');

  assert.deepEqual(fencedNpmCommands(doc), [
    { dir: 'backend', script: 'dev' },
    { dir: 'backend', script: 'serve' },
    { dir: 'frontend', script: 'test' },
    { dir: 'backend', script: 'lint' },
    { dir: '.', script: 'test:e2e' },
    { dir: '.', script: 'build' },
  ]);
  assert.deepEqual(missingScripts(fencedNpmCommands(doc)), [
    'backend: npm run serve',
    '.: npm run build',
  ]);
});
