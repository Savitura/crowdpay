const { validateWalletSecretConfig } = require('../services/walletSecrets');

const REQUIRED = ['JWT_SECRET', 'DATABASE_URL', 'PLATFORM_SECRET_KEY', 'STELLAR_NETWORK'];

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    const list = missing.map((k) => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: missing required environment variables:\n${list}\n\nSet them in your .env file.\n\n`
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
