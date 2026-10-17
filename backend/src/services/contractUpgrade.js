const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const {
  deployMilestonesV2Contract,
  deployMigrationContract,
  initializeMilestones,
  runMigration,
} = require('./sorobanService');

class UpgradeError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function assertNoActiveReview(campaignId) {
  const { rows } = await db.query(
    `SELECT id FROM milestones WHERE campaign_id = $1 AND status = 'pending_review' LIMIT 1`,
    [campaignId]
  );
  if (rows.length) {
    throw new UpgradeError(
      'A milestone is currently under review; the contract cannot be upgraded until it is resolved',
      409,
      'ACTIVE_REVIEW_IN_PROGRESS'
    );
  }
}

async function loadUpgradeableCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.escrow_contract_id, c.milestones_contract_id,
            c.escrow_contract_version, u.wallet_public_key AS creator_public_key
     FROM campaigns c
     JOIN users u ON u.id = c.creator_id
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [campaignId]
  );
  if (!rows.length) {
    throw new UpgradeError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
  }
  const campaign = rows[0];

  if (campaign.escrow_contract_version >= 2) {
    throw new UpgradeError('Campaign is already on the V2 contract', 400, 'ALREADY_V2');
  }
  if (!campaign.escrow_contract_id || !campaign.milestones_contract_id) {
    throw new UpgradeError(
      'Campaign has no V1 contracts deployed to migrate from',
      400,
      'NO_V1_CONTRACT'
    );
  }

  return campaign;
}

/**
 * Deploys a V2 milestones contract, seeds it with the campaign's milestone
 * definitions, and drives the migration orchestrator to pull the live V1
 * on-chain state (status, evidence) across before pointing the campaign at
 * the new contract. See contracts/soroban/contracts/{milestones_v2,migration}.
 */
async function upgradeCampaignContract(campaignId, adminUserId) {
  const campaign = await loadUpgradeableCampaign(campaignId);
  await assertNoActiveReview(campaignId);

  if (!process.env.PLATFORM_SECRET_KEY) {
    throw new UpgradeError('PLATFORM_SECRET_KEY not configured', 500, 'PLATFORM_KEY_MISSING');
  }
  const signerSecret = process.env.PLATFORM_SECRET_KEY;
  const platformPublicKey = Keypair.fromSecret(signerSecret).publicKey();

  const { rows: milestoneRows } = await db.query(
    `SELECT title, release_percentage FROM milestones
     WHERE campaign_id = $1 ORDER BY contract_index ASC NULLS LAST, created_at ASC`,
    [campaignId]
  );
  if (!milestoneRows.length) {
    throw new UpgradeError('Campaign has no milestones to migrate', 400, 'NO_MILESTONES');
  }

  const { rowCount } = await db.query(
    `UPDATE campaigns SET migration_in_progress = TRUE WHERE id = $1 AND migration_in_progress = FALSE`,
    [campaignId]
  );
  if (!rowCount) {
    throw new UpgradeError(
      'A migration is already in progress for this campaign',
      409,
      'MIGRATION_ALREADY_IN_PROGRESS'
    );
  }

  try {
    const v2Contract = await deployMilestonesV2Contract({ signerSecret });
    await initializeMilestones({
      contractId: v2Contract.contractId,
      creatorAddress: campaign.creator_public_key,
      platformAddress: platformPublicKey,
      escrowContractId: campaign.escrow_contract_id,
      milestones: milestoneRows,
      signerSecret,
    });

    const migrationContract = await deployMigrationContract({
      platformAddress: platformPublicKey,
      signerSecret,
    });

    const { txHash, milestoneCount } = await runMigration({
      migrationContractId: migrationContract.contractId,
      v1ContractId: campaign.milestones_contract_id,
      v2ContractId: v2Contract.contractId,
      signerSecret,
    });

    await db.query(
      `UPDATE campaigns
       SET previous_milestones_contract_id = milestones_contract_id,
           milestones_contract_id = $1,
           escrow_contract_version = 2,
           migration_in_progress = FALSE
       WHERE id = $2`,
      [v2Contract.contractId, campaignId]
    );

    logger.info('Milestone escrow contract upgraded to V2', {
      campaignId,
      adminUserId,
      v1ContractId: campaign.milestones_contract_id,
      v2ContractId: v2Contract.contractId,
      migrationTxHash: txHash,
      milestoneCount,
    });

    return {
      v1ContractId: campaign.milestones_contract_id,
      v2ContractId: v2Contract.contractId,
      migrationTxHash: txHash,
      milestoneCount,
    };
  } catch (err) {
    await db.query(`UPDATE campaigns SET migration_in_progress = FALSE WHERE id = $1`, [
      campaignId,
    ]);
    logger.error('Milestone escrow contract upgrade failed', {
      campaignId,
      adminUserId,
      error: err.message,
    });
    throw err;
  }
}

module.exports = {
  UpgradeError,
  upgradeCampaignContract,
};
