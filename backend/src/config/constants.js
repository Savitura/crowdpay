/**
 * constants.js
 *
 * Single source of truth for named numeric constants used across the backend.
 * Changing a value here propagates everywhere it is imported.
 */

module.exports = {
  // --------------------------------------------------------------------------------------
  // Stellar transaction timeouts (seconds)
  // --------------------------------------------------------------------------------------

  /** Timeout for contribution transactions (create-account, trustlines, payments). */
  TX_TIMEOUT_CONTRIBUTION_S: 30,

  /** Timeout for withdrawal transactions — platform approver may not be available immediately (see issue #128). */
  TX_TIMEOUT_WITHDRAWAL_S: 60 * 60 * 24 * 7, // 7 days

  // --------------------------------------------------------------------------------------
  // Campaign wallet Stellar multisig thresholds & weights (#1037)
  // --------------------------------------------------------------------------------------

  /** Standard campaign multisig thresholds: medium ops (payments) require both creator + platform (weight 2). */
  MULTISIG_STANDARD_THRESHOLDS: {
    masterWeight: 0,
    lowThreshold: 1,
    medThreshold: 2,
    highThreshold: 2,
  },

  /** Active dispute freeze thresholds: operations require creator + platform + arbitrator (weight 3). */
  MULTISIG_DISPUTE_FROZEN_THRESHOLDS: {
    medThreshold: 3,
    highThreshold: 3,
  },

  /** Released dispute freeze thresholds: restored to creator + platform (weight 2). */
  MULTISIG_DISPUTE_RELEASED_THRESHOLDS: {
    medThreshold: 2,
    highThreshold: 2,
  },

  /** Teardown / cleanup thresholds: lowered to 1 so platform can sweep & merge remaining balance. */
  MULTISIG_CLEANUP_THRESHOLDS: {
    lowThreshold: 1,
    medThreshold: 1,
    highThreshold: 1,
  },

  /** Standard signer weight for authorized multisig signers (creator, platform, arbitrator). */
  MULTISIG_SIGNER_WEIGHT: 1,

  /** Weight to remove / revoke a signer. */
  MULTISIG_SIGNER_WEIGHT_REMOVE: 0,

  /** Weight to disable the master keypair itself. */
  MULTISIG_MASTER_WEIGHT_DISABLED: 0,

  // --------------------------------------------------------------------------------------
  // Path payment slippage buffer
  // --------------------------------------------------------------------------------------

  /** Maximum slippage allowed on DEX path payments, in basis points (500 = 5.00%). */
  SLIPPAGE_BPS: 500,

  // --------------------------------------------------------------------------------------
  // Custodial account XLM reserves
  // --------------------------------------------------------------------------------------

  /** Base XLM reserve required for a new custodial account (covers account minimum + one entry). */
  CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM: 2.5,

  /** Additional XLM reserve required per trustline on a custodial account. */
  CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM: 0.51,

  // --------------------------------------------------------------------------------------
  // Ledger monitor reconnect back-off
  // --------------------------------------------------------------------------------------

  /** Initial reconnect delay for the ledger payment stream, in milliseconds. */
  LEDGER_MONITOR_RECONNECT_DELAY_MS: 5_000,

  // --------------------------------------------------------------------------------------
  // Soroban contract amounts
  // --------------------------------------------------------------------------------------

  /** Scale factor between a decimal asset amount and the contract's i128 unit (7 decimal places, matching Stellar's native precision). */
  STELLAR_ASSET_DECIMALS_SCALE: 10_000_000,

  // --------------------------------------------------------------------------------------
  // Milestone limits
  // --------------------------------------------------------------------------------------

  /** Maximum number of milestones a campaign can define. */
  MILESTONE_LIMIT: 5,

  /** Maximum file size (in bytes) for milestone evidence uploads (10 MB). */
  MILESTONE_EVIDENCE_MAX_FILE_SIZE: 10 * 1024 * 1024,

  /**
   * Hard floor for an auto-releasing milestone's dispute window (24 hours).
   * Creators may shorten the platform default down to this, never below it, and
   * the database enforces the same floor (20260929_milestone_auto_release.sql).
   */
  MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS: 24 * 60 * 60,

  /**
   * Platform default dispute window (72 hours). Overridable with
   * MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_HOURS, but never below the floor above.
   */
  MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS: 72 * 60 * 60,

  /** Validity window of an automated release transaction, so a stalled one expires quickly and can be reconciled. */
  MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S: 15 * 60,

  // --------------------------------------------------------------------------------------
  // Upload limits
  // --------------------------------------------------------------------------------------

  /** Maximum file size (in bytes) for campaign cover image uploads (5 MB). */
  MAX_UPLOAD_SIZE: 5 * 1024 * 1024,

  /** Allowed MIME types for campaign cover image uploads. */
  ALLOWED_UPLOAD_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'],

  // --------------------------------------------------------------------------------------
  // Admin
  // --------------------------------------------------------------------------------------

  /** Impersonation token TNL in seconds (15 minutes). */
  IMPERSONATION_TTL_SECONDS: 15 * 60,

  /** Maximum number of admin audit log entries that can be returned in a single query. */
  ADMIN_AUDIT_LOG_MAX_LIMIT: 1000,

  // --------------------------------------------------------------------------------------
  // Impact summary
  // --------------------------------------------------------------------------------------

  /** Cache TTL for public campaign impact stats (seconds). */
  IMPACT_CACHE_TTL_SECONDS: 60,
};
