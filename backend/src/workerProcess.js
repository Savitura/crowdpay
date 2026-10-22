// Standalone entry point for the background workers (`npm run worker`, or
// `npm run dev:worker` with hot reload). It starts the same jobs that
// src/index.js starts once the HTTP server is listening, without opening a
// port, so the web server and the workers can run as two processes. Start the
// web server with WORKER_ENABLED=false next to it, or every job runs twice.
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
}

const logger = require('./config/logger');
const { validateEnv } = require('./config/env');
const { startBackgroundWorkers, stopBackgroundWorkers } = require('./worker');

/**
 * Starts the background workers in this process.
 * @returns {Promise<boolean>} false when the configuration disables them.
 */
async function runWorkerProcess() {
  if (process.env.WORKER_ENABLED === 'false' || process.env.NODE_ENV === 'test') {
    logger.error('worker: disabled by WORKER_ENABLED=false or NODE_ENV=test, nothing to run');
    return false;
  }

  validateEnv();
  logger.info('worker: running as a standalone process, no HTTP server');
  await startBackgroundWorkers();
  return true;
}

async function shutdown() {
  logger.info('Received shutdown signal, stopping background workers...');
  await stopBackgroundWorkers();
  process.exit(0);
}

async function main() {
  let started = false;
  try {
    started = await runWorkerProcess();
  } catch (err) {
    logger.error('worker: failed to start', { error: err.message });
  }
  if (!started) process.exit(1);
}

if (require.main === module) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  main();
}

module.exports = { runWorkerProcess };
