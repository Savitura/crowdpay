/**
 * publicCampaignColumns.js
 *
 * Single source of truth for which `campaigns` columns may be serialised to
 * API consumers (#899).
 *
 * `GET /api/campaigns` and `GET /api/campaigns/:id` are unauthenticated and
 * were built from `SELECT c.*`, so every column on the row reached the JSON
 * body — including the fraud detector's own output (`fraud_signals`,
 * `fraud_score`, `is_flagged_fraud`), the duplicate-detection fingerprint
 * (`content_fingerprint`) and `wallet_secret_encrypted`, the column reserved
 * for the encrypted campaign wallet key that the owner/admin wallet recovery
 * flow already reads.
 *
 * `CAMPAIGN_TABLE_COLUMNS` mirrors the `campaigns` table as defined by
 * `db/schema.sql` plus the `ALTER TABLE campaigns ADD COLUMN` statements in
 * `db/migrations`. Anything a client must not receive goes in
 * `INTERNAL_CAMPAIGN_COLUMNS`; new columns only become public when they are
 * deliberately added below, so a freshly added sensitive column cannot leak by
 * accident.
 */

'use strict';

// Every column on the `campaigns` table (schema.sql + migration history).
// `id` is kept first (primary key convention); the rest stay alphabetical.
const CAMPAIGN_TABLE_COLUMNS = [
  'id',
  'auditor_public_key',
  'asset_type',
  'campaign_github_stats',
  'category',
  'cloned_from',
  'content_fingerprint',
  'contract_address',
  'contract_deployed_at',
  'contract_deployment_error',
  'contract_deployment_status',
  'contract_id',
  'contract_version',
  'country',
  'cover_image_url',
  'created_at',
  'creator_id',
  'deadline',
  'deleted_at',
  'description',
  'escrow_contract_id',
  'escrow_contract_version',
  'escrow_funded_at',
  'featured',
  'featured_at',
  'featured_note',
  'fraud_score',
  'fraud_signals',
  'github_repo_url',
  'is_flagged_duplicate',
  'is_flagged_fraud',
  'is_hidden',
  'last_deployment_attempt_at',
  'max_contribution',
  'max_per_user',
  'migration_in_progress',
  'milestones_contract_id',
  'min_contribution',
  'platform_fee_bps',
  'previous_milestones_contract_id',
  'raised_amount',
  'refund_initiated_at',
  'refund_tx_hash',
  'refund_xdr',
  'scheduled_publish_at',
  'search_vector',
  'share_count',
  'show_backer_amounts',
  'status',
  'target_amount',
  'template_id',
  'title',
  'velocity_alert_threshold',
  'wallet_mode',
  'wallet_public_key',
  'wallet_secret_encrypted',
];

/**
 * Columns that must never appear in a client payload.
 *
 * - fraud/duplicate detector internals: an attacker tuning evasion only needs
 *   the detector's output, so `fraud_*` and `content_fingerprint` stay private.
 * - `wallet_secret_encrypted`: the encrypted campaign wallet key.
 * - `search_vector`: generated tsvector used only for full-text search.
 * - `refund_xdr`: raw unsigned refund transaction.
 * - `migration_in_progress` / `contract_deployment_error`: internal state and
 *   provider diagnostics.
 */
const INTERNAL_CAMPAIGN_COLUMNS = [
  'content_fingerprint',
  'contract_deployment_error',
  'fraud_score',
  'fraud_signals',
  'is_flagged_duplicate',
  'is_flagged_fraud',
  'migration_in_progress',
  'refund_xdr',
  'search_vector',
  'wallet_secret_encrypted',
];

const PUBLIC_CAMPAIGN_COLUMNS = CAMPAIGN_TABLE_COLUMNS.filter(
  column => !INTERNAL_CAMPAIGN_COLUMNS.includes(column)
);

/**
 * Build a SQL column list for a `campaigns` alias (defaults to `c`). Pass an
 * empty alias to select from an unaliased `INSERT ... RETURNING`.
 *
 * The list is kept on one line so query-shape assertions elsewhere (e.g. the
 * anchor callback tests matching `FROM campaigns c JOIN users u`) still hold.
 */
function publicCampaignColumnList(alias = 'c') {
  const prefix = alias ? `${alias}.` : '';
  return PUBLIC_CAMPAIGN_COLUMNS.map(column => `${prefix}${column}`).join(', ');
}

const PUBLIC_CAMPAIGN_SELECT = publicCampaignColumnList('c');

/**
 * Return a shallow copy of a campaign row with every internal column removed.
 * Used as defence in depth next to the SQL allowlist so a stray `SELECT *`
 * (or a widened query) can never serialise a secret.
 */
function stripInternalCampaignFields(row) {
  if (!row || typeof row !== 'object') return row;
  const clean = { ...row };
  for (const column of INTERNAL_CAMPAIGN_COLUMNS) {
    delete clean[column];
  }
  return clean;
}

module.exports = {
  CAMPAIGN_TABLE_COLUMNS,
  INTERNAL_CAMPAIGN_COLUMNS,
  PUBLIC_CAMPAIGN_COLUMNS,
  PUBLIC_CAMPAIGN_SELECT,
  publicCampaignColumnList,
  stripInternalCampaignFields,
};
