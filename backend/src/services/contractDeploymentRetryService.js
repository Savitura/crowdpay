const db = require('../config/database');
const logger = require('../config/logger');
const Sentry = require('@sentry/node');
const { deployCampaignContracts } = require('./sorobanService');
const { Keypair } = require('@stellar/stellar-sdk');
const { toStroops } = require('../utils/stroops');

const RETRY_LOCK_KEY = 323002;
const MAX_RETRIES_PER_RUN = 10;
const MIN_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Retry failed contract deployments for campaigns stuck in 'failed' status.
 * Guarded by a Postgres advisory lock so overlapping cron ticks do not run in parallel.
 */
async function retryFailedContractDeployments() {
  const client = await db.connect();
  let lockAcquired = false;

  try {
    const { rows: lockRows } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [RETRY_LOCK_KEY]
    );
    lockAcquired = lockRows[0]?.acquired === true;
    if (!lockAcquired) {
      logger.info('Contract deployment retry skipped — another instance holds the advisory lock');
      return { retried: 0, succeeded: 0, failed: 0, skipped: true };
    }

    // Find campaigns with failed deployment, waiting at least MIN_BACKOFF_MS since last attempt
    const { rows: campaigns } = await client.query(
      `SELECT c.id, c.title, c.creator_id, c.deadline, c.target_amount,
              c.asset_type, c.platform_fee_bps, c.contract_deployment_error,
              c.last_deployment_attempt_at,
              u.wallet_public_key AS creator_public_key
       FROM campaigns c
       JOIN users u ON u.id = c.creator_id
       WHERE c.contract_deployment_status = 'failed'
         AND c.deleted_at IS NULL
         AND c.last_deployment_attempt_at < NOW() - INTERVAL '5 minutes'
       ORDER BY c.last_deployment_attempt_at ASC
       LIMIT $1`,
      [MAX_RETRIES_PER_RUN]
    );

    if (!campaigns.length) {
      return { retried: 0, succeeded: 0, failed: 0, skipped: false };
    }

    const platformSecret = process.env.PLATFORM_SECRET_KEY;
    if (!platformSecret) {
      logger.warn('Skipping contract deployment retry — PLATFORM_SECRET_KEY not configured');
      return { retried: 0, succeeded: 0, failed: 0, skipped: false };
    }

    const platformPublicKey = Keypair.fromSecret(platformSecret).publicKey();
    const assetContractAddress = process.env.USDC_CONTRACT_ADDRESS || process.env.USDC_ISSUER;

    let succeeded = 0;
    let failed = 0;

    for (const campaign of campaigns) {
      // Mark as deploying
      await client.query(
        `UPDATE campaigns
         SET contract_deployment_status = 'deploying',
             last_deployment_attempt_at = NOW()
         WHERE id = $1`,
        [campaign.id]
      );

      const deadlineUnix = campaign.deadline
        ? Math.floor(new Date(campaign.deadline).getTime() / 1000)
        : 0;

      try {
        const { escrowContractId, milestonesContractId } = await deployCampaignContracts({
          creatorPublicKey: campaign.creator_public_key,
          platformPublicKey,
          campaignId: campaign.title + Date.now(),
          targetAmount: toStroops(campaign.target_amount),
          deadlineUnix,
          assetContractAddress,
          platformFeeBps: campaign.platform_fee_bps || 0,
          milestones: [],
          signerSecret: platformSecret,
        });

        await client.query(
          `UPDATE campaigns
           SET escrow_contract_id = COALESCE(escrow_contract_id, $1),
               milestones_contract_id = COALESCE(milestones_contract_id, $2),
               contract_address = COALESCE(contract_address, $1),
               contract_deployed_at = COALESCE(contract_deployed_at, NOW()),
               contract_deployment_status = 'deployed',
               contract_deployment_error = NULL,
               last_deployment_attempt_at = NOW()
           WHERE id = $3`,
          [escrowContractId, milestonesContractId, campaign.id]
        );

        logger.info('Contract deployment retry succeeded', {
          campaignId: campaign.id,
          escrowContractId,
        });
        succeeded++;
      } catch (err) {
        await client.query(
          `UPDATE campaigns
           SET contract_deployment_status = 'failed',
               contract_deployment_error = $1,
               last_deployment_attempt_at = NOW()
           WHERE id = $2`,
          [err.message, campaign.id]
        );

        logger.error('Contract deployment retry failed', {
          campaignId: campaign.id,
          error: err.message,
          previousError: campaign.contract_deployment_error,
        });

        Sentry.withScope((scope) => {
          scope.setLevel('warning');
          scope.setTag('cron_redeploy', 'contract_deployment');
          scope.setContext('deployment', {
            campaignId: campaign.id,
            error: err.message,
            previousError: campaign.contract_deployment_error,
          });
          Sentry.captureMessage(
            `Contract deployment retry failed for campaign ${campaign.id}: ${err.message}`
          );
        });

        failed++;
      }
    }

    logger.info('Contract deployment retry batch completed', {
      retried: campaigns.length,
      succeeded,
      failed,
    });

    return { retried: campaigns.length, succeeded, failed, skipped: false };
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [RETRY_LOCK_KEY]);
    }
    client.release();
  }
}

module.exports = { retryFailedContractDeployments };
