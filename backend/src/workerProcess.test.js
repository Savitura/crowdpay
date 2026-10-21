const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function noop() {}

function buildWorkerProcess(calls) {
  return proxyquire('./workerProcess', {
    './config/logger': { info: noop, error: noop, warn: noop, debug: noop },
    './config/env': {
      validateEnv: () => calls.push('validateEnv'),
    },
    './worker': {
      startBackgroundWorkers: async () => calls.push('startBackgroundWorkers'),
      stopBackgroundWorkers: async () => calls.push('stopBackgroundWorkers'),
    },
  });
}

test('Standalone worker process', async t => {
  let originalEnv;

  t.beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  t.afterEach(() => {
    process.env = originalEnv;
  });

  await t.test('validates the environment, then starts the background workers', async () => {
    const calls = [];
    const { runWorkerProcess } = buildWorkerProcess(calls);
    process.env.NODE_ENV = 'development';
    delete process.env.WORKER_ENABLED;

    assert.equal(await runWorkerProcess(), true);
    assert.deepEqual(calls, ['validateEnv', 'startBackgroundWorkers']);
  });

  await t.test('refuses to start when WORKER_ENABLED is false', async () => {
    const calls = [];
    const { runWorkerProcess } = buildWorkerProcess(calls);
    process.env.NODE_ENV = 'development';
    process.env.WORKER_ENABLED = 'false';

    assert.equal(await runWorkerProcess(), false);
    assert.deepEqual(calls, []);
  });
});
