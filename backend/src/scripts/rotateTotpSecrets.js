require('dotenv').config();

const db = require('../config/database');
const {
  rotateLegacyUserTotpSecrets,
  validateWalletSecretConfig,
} = require('../services/walletSecrets');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1',
    confirm: args.includes('--confirm'),
  };
}

async function main() {
  const { dryRun, confirm } = parseArgs();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  validateWalletSecretConfig();

  if (!dryRun && !confirm) {
    throw new Error(
      'This is a destructive production operation. Use --confirm to proceed or --dry-run to simulate.'
    );
  }

  const result = await rotateLegacyUserTotpSecrets({ runner: db, dryRun });
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

  if (result.invalid > 0) {
    throw new Error(`${result.invalid} TOTP secret(s) could not be migrated`);
  }
}

main()
  .catch(err => {
    process.stderr.write(`[rotate-totp-secrets] ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_err) {
      // noop
    }
  });
