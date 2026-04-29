require('dotenv').config();

const db = require('../config/database');
const {
  rotateLegacyUserWalletSecrets,
  validateWalletSecretConfig,
} = require('../services/walletSecrets');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  validateWalletSecretConfig();

  const dryRun = process.env.DRY_RUN === '1';
  const result = await rotateLegacyUserWalletSecrets({ runner: db, dryRun });

  process.stdout.write(
    JSON.stringify(
      {
        ...result,
        dry_run: dryRun,
      },
      null,
      2
    ) + '\n'
  );
}

main()
  .catch((err) => {
    process.stderr.write(`[rotate-wallet-secrets] ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_err) {
      // noop
    }
  });
