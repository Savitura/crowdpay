const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const { REQUIRED } = require('./env');

// Templates a contributor copies to backend/.env (see docs/environment.md).
const BACKEND_DIR = path.join(__dirname, '..', '..');
const TEMPLATES = ['.env.example', '.env.demo.template'];

// Values marked GENERATE in the templates. Their placeholders must fail
// validation, so these test values stand in for the ones a developer creates.
const GENERATED = {
  PLATFORM_SECRET_KEY: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
  ARBITRATOR_SECRET_KEY: 'SD5R3ADP7AC37OAYWYG73266DR2MBR6IJGXBLLAGCOWMTHLMPFAJMWPM',
  WALLET_ENCRYPTION_KEY: 'a'.repeat(64),
  WALLET_SECRET_LOCAL_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

// Reloaded for every run: walletService caches the decoded key, and the other
// validators read process.env when they are called.
const VALIDATOR_MODULES = [
  './env',
  '../services/walletService',
  '../services/walletSecrets',
  '../services/geoipService',
];

function readTemplate(name) {
  return dotenv.parse(fs.readFileSync(path.join(BACKEND_DIR, name), 'utf8'));
}

// Runs the real startup validator against exactly `env`, with process.exit and
// stderr captured so a failed rule is reported instead of ending the test run.
function runValidateEnv(env) {
  const saved = { env: process.env, exit: process.exit, write: process.stderr.write };
  const exitCalls = [];
  const stderr = [];
  process.env = { ...env };
  process.exit = code => {
    exitCalls.push(code);
    throw new Error('__EXIT__');
  };
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    for (const id of VALIDATOR_MODULES) delete require.cache[require.resolve(id)];
    require('./env').validateEnv();
  } catch (err) {
    if (!exitCalls.length) throw err;
  } finally {
    process.env = saved.env;
    process.exit = saved.exit;
    process.stderr.write = saved.write;
  }
  return { exitCalls, stderr: stderr.join('') };
}

for (const name of TEMPLATES) {
  test(`${name} sets every variable the startup validator requires`, () => {
    const template = readTemplate(name);
    const missing = REQUIRED.filter(key => !template[key]);
    assert.deepEqual(missing, [], `${name} must set: ${missing.join(', ')}`);
  });

  test(`${name} passes the startup validator once the GENERATE values are set`, () => {
    const { exitCalls, stderr } = runValidateEnv({ ...readTemplate(name), ...GENERATED });
    assert.deepEqual(exitCalls, [], stderr);
    assert.doesNotMatch(stderr, /Cannot start/);
  });

  for (const key of Object.keys(GENERATED)) {
    test(`${name} placeholder for ${key} is rejected at startup`, () => {
      const template = readTemplate(name);
      assert.ok(template[key], `${name} must set a placeholder for ${key}`);
      const { exitCalls, stderr } = runValidateEnv({
        ...template,
        ...GENERATED,
        [key]: template[key],
      });
      assert.deepEqual(exitCalls, [1]);
      assert.match(stderr, new RegExp(`Cannot start[\\s\\S]*${key}`));
    });
  }
}
