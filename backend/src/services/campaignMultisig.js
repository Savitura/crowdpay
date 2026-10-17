/**
 * campaignMultisig.js
 *
 * Single source of truth for Stellar campaign wallet multi-signature configuration,
 * threshold policies, and SetOptions operation builders.
 *
 * Used by backend/src/services/stellarService.js during wallet initialization,
 * dispute freeze (3-of-3), freeze release (2-of-2), and account closure.
 */

const { Operation } = require('@stellar/stellar-sdk');
const {
  MULTISIG_STANDARD_THRESHOLDS,
  MULTISIG_DISPUTE_FROZEN_THRESHOLDS,
  MULTISIG_DISPUTE_RELEASED_THRESHOLDS,
  MULTISIG_CLEANUP_THRESHOLDS,
  MULTISIG_SIGNER_WEIGHT,
  MULTISIG_SIGNER_WEIGHT_REMOVE,
  MULTISIG_MASTER_WEIGHT_DISABLED,
} = require('../config/constants');

/**
 * Builds the SetOptions operation to add a signer with a specific weight.
 *
 * @param {string} ed25519PublicKey - Public key of the signer
 * @param {number} [weight=MULTISIG_SIGNER_WEIGHT] - Weight of the signer
 * @returns {object} Operation.setOptions
 */
function buildAddSignerOperation(ed25519PublicKey, weight = MULTISIG_SIGNER_WEIGHT) {
  if (!ed25519PublicKey || typeof ed25519PublicKey !== 'string') {
    throw new Error('A valid ed25519PublicKey string is required to configure a signer');
  }
  return Operation.setOptions({
    signer: { ed25519PublicKey, weight },
  });
}

/**
 * Builds the SetOptions operation to remove / revoke a signer (weight: 0).
 *
 * @param {string} ed25519PublicKey - Public key of the signer to remove
 * @returns {object} Operation.setOptions
 */
function buildRemoveSignerOperation(ed25519PublicKey) {
  return buildAddSignerOperation(ed25519PublicKey, MULTISIG_SIGNER_WEIGHT_REMOVE);
}

/**
 * Builds the array of SetOptions operations to configure standard 2-of-2 multisig
 * on a newly created campaign wallet:
 *   1. Creator signer (weight 1)
 *   2. Platform signer (weight 1)
 *   3. Master key disabled (weight 0), thresholds set to low: 1, med: 2, high: 2
 *
 * @param {object} params
 * @param {string} params.creatorPublicKey - Public key of campaign creator
 * @param {string} params.platformPublicKey - Public key of platform
 * @returns {Array<object>} Array of Operation.setOptions
 */
function buildCampaignMultisigOperations({ creatorPublicKey, platformPublicKey }) {
  if (!creatorPublicKey || typeof creatorPublicKey !== 'string') {
    throw new Error('creatorPublicKey is required for campaign multisig setup');
  }
  if (!platformPublicKey || typeof platformPublicKey !== 'string') {
    throw new Error('platformPublicKey is required for campaign multisig setup');
  }

  return [
    buildAddSignerOperation(creatorPublicKey, MULTISIG_SIGNER_WEIGHT),
    buildAddSignerOperation(platformPublicKey, MULTISIG_SIGNER_WEIGHT),
    Operation.setOptions({
      masterWeight: MULTISIG_MASTER_WEIGHT_DISABLED,
      lowThreshold: MULTISIG_STANDARD_THRESHOLDS.lowThreshold,
      medThreshold: MULTISIG_STANDARD_THRESHOLDS.medThreshold,
      highThreshold: MULTISIG_STANDARD_THRESHOLDS.highThreshold,
    }),
  ];
}

/**
 * Applies campaign multisig operations directly onto a TransactionBuilder instance.
 *
 * @param {object} builder - Stellar TransactionBuilder instance
 * @param {object} params - Same params as buildCampaignMultisigOperations
 * @returns {object} The builder instance
 */
function applyCampaignMultisig(builder, params) {
  const ops = buildCampaignMultisigOperations(params);
  for (const op of ops) {
    builder.addOperation(op);
  }
  return builder;
}

/**
 * Builds SetOptions operations for freezing a campaign escrow under dispute (3-of-3):
 *   1. Arbitrator signer (weight 1)
 *   2. Thresholds raised to med: 3, high: 3
 *
 * @param {object} params
 * @param {string} params.arbitratorPublicKey - Public key of platform arbitrator
 * @returns {Array<object>} Array of Operation.setOptions
 */
function buildFreezeEscrowOperations({ arbitratorPublicKey }) {
  if (!arbitratorPublicKey || typeof arbitratorPublicKey !== 'string') {
    throw new Error('arbitratorPublicKey is required to freeze campaign escrow');
  }

  return [
    buildAddSignerOperation(arbitratorPublicKey, MULTISIG_SIGNER_WEIGHT),
    Operation.setOptions({
      medThreshold: MULTISIG_DISPUTE_FROZEN_THRESHOLDS.medThreshold,
      highThreshold: MULTISIG_DISPUTE_FROZEN_THRESHOLDS.highThreshold,
    }),
  ];
}

/**
 * Builds SetOptions operations for releasing a dispute freeze (restoring to 2-of-2):
 *   1. Arbitrator signer revoked (weight 0)
 *   2. Thresholds restored to med: 2, high: 2
 *
 * @param {object} params
 * @param {string} params.arbitratorPublicKey - Public key of platform arbitrator
 * @returns {Array<object>} Array of Operation.setOptions
 */
function buildReleaseEscrowFreezeOperations({ arbitratorPublicKey }) {
  if (!arbitratorPublicKey || typeof arbitratorPublicKey !== 'string') {
    throw new Error('arbitratorPublicKey is required to release campaign escrow freeze');
  }

  return [
    buildRemoveSignerOperation(arbitratorPublicKey),
    Operation.setOptions({
      medThreshold: MULTISIG_DISPUTE_RELEASED_THRESHOLDS.medThreshold,
      highThreshold: MULTISIG_DISPUTE_RELEASED_THRESHOLDS.highThreshold,
    }),
  ];
}

/**
 * Builds SetOptions operations for closing a campaign wallet:
 *   1. Remove wallet keypair signer (if provided)
 *   2. Remove platform signer (if provided)
 *   3. Lower thresholds to low: 1, med: 1, high: 1 to allow account merge
 *
 * @param {object} [params={}]
 * @param {string} [params.walletPublicKey] - Public key of wallet to remove
 * @param {string} [params.platformPublicKey] - Public key of platform to remove
 * @returns {Array<object>} Array of Operation.setOptions
 */
function buildCloseWalletMultisigOperations({ walletPublicKey, platformPublicKey } = {}) {
  const ops = [];
  if (walletPublicKey) {
    ops.push(buildRemoveSignerOperation(walletPublicKey));
  }
  if (platformPublicKey) {
    ops.push(buildRemoveSignerOperation(platformPublicKey));
  }
  ops.push(
    Operation.setOptions({
      lowThreshold: MULTISIG_CLEANUP_THRESHOLDS.lowThreshold,
      medThreshold: MULTISIG_CLEANUP_THRESHOLDS.medThreshold,
      highThreshold: MULTISIG_CLEANUP_THRESHOLDS.highThreshold,
    })
  );
  return ops;
}

module.exports = {
  MULTISIG_STANDARD_THRESHOLDS,
  MULTISIG_DISPUTE_FROZEN_THRESHOLDS,
  MULTISIG_DISPUTE_RELEASED_THRESHOLDS,
  MULTISIG_CLEANUP_THRESHOLDS,
  MULTISIG_SIGNER_WEIGHT,
  MULTISIG_SIGNER_WEIGHT_REMOVE,
  MULTISIG_MASTER_WEIGHT_DISABLED,
  buildAddSignerOperation,
  buildRemoveSignerOperation,
  buildCampaignMultisigOperations,
  applyCampaignMultisig,
  buildFreezeEscrowOperations,
  buildReleaseEscrowFreezeOperations,
  buildCloseWalletMultisigOperations,
};
