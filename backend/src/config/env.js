const { validateWalletSecretConfig } = require('../services/walletSecrets');

const REQUIRED = ['JWT_SECRET', 'DATABASE_URL', 'PLATFORM_SECRET_KEY', 'STELLAR_NETWORK'];
const STORAGE_VARS = ['STORAGE_BUCKET', 'STORAGE_ENDPOINT'];

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    const list = missing.map((k) => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: missing required environment variables:\n${list}\n\nSet them in your .env file.\n\n`
    );
    process.exit(1);
  }

  const storageConfigured = STORAGE_VARS.some((key) => !!process.env[key]);
  const storageMissing = STORAGE_VARS.filter((key) => !process.env[key]);
  if (storageConfigured && storageMissing.length) {
    const list = storageMissing.map((k) => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: incomplete storage configuration. Set all of:\n${STORAGE_VARS.join(', ')}\n\nMissing:\n${list}\n\n`
    );
    process.exit(1);
  }

  try {
    validateWalletSecretConfig();
  } catch (err) {
    process.stderr.write(`\n[crowdpay] Cannot start: ${err.message}\n\n`);
    process.exit(1);
  }
}

module.exports = { validateEnv };
