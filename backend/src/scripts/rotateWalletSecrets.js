require('dotenv').config();

const db = require('../config/database');
const {
  rotateLegacyUserWalletSecrets,
  reencryptAllUserWalletSecrets,
  validateWalletSecretConfig,
} = require('../services/walletSecrets');
const {
  reencryptSecret,
  needsReencryption,
  validateWalletEncryptionKey,
} = require('../services/walletService');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1',
    confirm: args.includes('--confirm'),
    reencrypt: args.includes('--reencrypt') || args.includes('--all'),
  };
}

async function reencryptCampaignSecrets({ runner = db, dryRun = false } = {}) {
  const { rows } = await runner.query(
    'SELECT id, wallet_secret_encrypted FROM campaigns WHERE wallet_secret_encrypted IS NOT NULL ORDER BY created_at ASC, id ASC'
  );

  let reencrypted = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    if (!needsReencryption(row.wallet_secret_encrypted)) {
      skipped += 1;
      continue;
    }

    try {
      const updated = reencryptSecret(row.wallet_secret_encrypted);
      if (!dryRun) {
        await runner.query('UPDATE campaigns SET wallet_secret_encrypted = $1 WHERE id = $2', [
          updated,
          row.id,
        ]);
      }
      reencrypted += 1;
    } catch (_err) {
      errors += 1;
    }
  }

  return {
    total: rows.length,
    reencrypted,
    skipped,
    errors,
  };
}

async function main() {
  const { dryRun, confirm, reencrypt } = parseArgs();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  validateWalletSecretConfig();
  validateWalletEncryptionKey();

  if (!dryRun && !confirm) {
    throw new Error(
      'This is a destructive production operation. Use --confirm to proceed or --dry-run to simulate.'
    );
  }

  const legacyResult = await rotateLegacyUserWalletSecrets({ runner: db, dryRun });
  let reencryptResult = null;
  let campaignSecretsResult = null;

  if (reencrypt) {
    reencryptResult = await reencryptAllUserWalletSecrets({ runner: db, dryRun });
    campaignSecretsResult = await reencryptCampaignSecrets({ runner: db, dryRun });
  }

  process.stdout.write(
    JSON.stringify(
      {
        legacy_plaintext_migration: legacyResult,
        ...(reencrypt ? { user_wallet_secrets_reencrypted: reencryptResult } : {}),
        ...(reencrypt ? { campaign_wallet_secrets_reencrypted: campaignSecretsResult } : {}),
        dry_run: dryRun,
      },
      null,
      2
    ) + '\n'
  );
}

main()
  .catch(err => {
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
