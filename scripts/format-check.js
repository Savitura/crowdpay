const { spawnSync } = require('node:child_process');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const workspace = path.relative(workspaceRoot, process.cwd());
const sourceDirectories = {
  backend: ['src', 'db', 'scripts'],
  frontend: ['src'],
}[workspace];

if (!sourceDirectories) {
  console.error('Run format:check from the backend or frontend workspace.');
  process.exit(1);
}

const baseSha = process.env.FORMAT_BASE_SHA;
let files = sourceDirectories;

if (baseSha) {
  const changed = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${baseSha}...HEAD`], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  if (changed.status !== 0) {
    process.stderr.write(changed.stderr);
    process.exit(changed.status || 1);
  }

  const prefixes = sourceDirectories.map((directory) => `${workspace}/${directory}/`);
  const prettierExtensions = /\.(?:[cm]?js|jsx|json|md|ya?ml|css|html)$/i;
  files = changed.stdout
    .split('\n')
    .filter((file) => prefixes.some((prefix) => file.startsWith(prefix)) && prettierExtensions.test(file))
    .map((file) => path.relative(workspace, file));

  if (!files.length) {
    console.log('No changed Prettier-supported files to check.');
    process.exit(0);
  }
}

const prettier = path.join(process.cwd(), 'node_modules', '.bin', 'prettier');
const result = spawnSync(prettier, ['--check', ...files], { stdio: 'inherit' });
// Exit with Prettier's status; fall back to 1 only if it never produced a
// status (e.g. killed by a signal). Using `|| 1` here would turn a successful
// run (status 0) into a failure, since `0 || 1 === 1`.
process.exit(result.status ?? 1);