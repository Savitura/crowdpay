'use strict';

/**
 * Contributor-controlled public attribution (issue #944).
 *
 * Contributing with a Stellar wallet always records the wallet key privately so
 * creators and compliance keep an auditable trail, but what is *publicly*
 * shown is chosen by the contributor:
 *
 *   - `public`       the Stellar wallet key (and chosen display name)
 *   - `display_name` only the chosen display name, never the wallet key
 *   - `anonymous`    neither the wallet key nor any display name
 *
 * An account-wide preference (`users.contributor_privacy`) can be even more
 * restrictive; the effective mode is always the more private of the two so a
 * contributor who has opted down to anonymous is never surfaced publicly.
 *
 * Anonymous contributions still count toward campaign totals and distinct
 * contributor metrics: aggregation queries key off `sender_public_key`, which
 * is still stored on every row regardless of the attribution mode.
 */

const db = require('../config/database');

const ATTRIBUTION_MODES = Object.freeze(['public', 'display_name', 'anonymous']);

const ATTRIBUTION_RESTRICTIVENESS = Object.freeze({
  public: 0,
  display_name: 1,
  anonymous: 2,
});

function isAttributionMode(mode) {
  return typeof mode === 'string' && ATTRIBUTION_MODES.includes(mode);
}

function normalizeAttributionMode(mode, fallback = 'public') {
  if (mode === undefined || mode === null || mode === '') return fallback;
  if (!isAttributionMode(mode)) {
    const error = new Error(`attribution_mode must be one of: ${ATTRIBUTION_MODES.join(', ')}`);
    error.statusCode = 422;
    error.code = 'INVALID_ATTRIBUTION_MODE';
    throw error;
  }
  return mode;
}

/**
 * Map the account-wide `users.contributor_privacy` value onto an attribution
 * mode. Legacy `amount_only` (identity hidden, amount public) is treated as
 * `anonymous` for identity purposes; amount visibility is controlled separately
 * by the campaign's `show_backer_amounts` setting.
 */
function accountPrivacyToAttributionMode(contributorPrivacy) {
  if (contributorPrivacy === 'anonymous' || contributorPrivacy === 'amount_only') {
    return 'anonymous';
  }
  if (contributorPrivacy === 'display_name') {
    return 'display_name';
  }
  return 'public';
}

/**
 * The stored mode is the more restrictive of the mode requested for a single
 * contribution and the contributor's account-wide preference.
 */
function resolveStoredAttributionMode({ requestedMode, contributorPrivacy } = {}) {
  const requested = normalizeAttributionMode(requestedMode, 'public');
  const account = accountPrivacyToAttributionMode(contributorPrivacy);
  return ATTRIBUTION_RESTRICTIVENESS[requested] >= ATTRIBUTION_RESTRICTIVENESS[account]
    ? requested
    : account;
}

/**
 * Project a contribution row onto its public representation, dropping every
 * private identity field the chosen mode hides. `showAmount` mirrors the
 * campaign-level `show_backer_amounts` setting and is independent of identity.
 */
function serializePublicAttribution(row, { showAmount = true } = {}) {
  const mode = normalizeAttributionMode(row.attribution_mode, 'public');
  const amount = showAmount ? (row.amount ?? null) : null;

  if (mode === 'anonymous') {
    return {
      display_name: null,
      sender_public_key: null,
      amount,
      asset: row.asset,
      created_at: row.created_at,
      contributor_privacy: mode,
    };
  }

  if (mode === 'display_name') {
    return {
      display_name: row.display_name || null,
      sender_public_key: null,
      amount,
      asset: row.asset,
      created_at: row.created_at,
      contributor_privacy: mode,
    };
  }

  return {
    display_name: row.display_name || null,
    sender_public_key: row.sender_public_key || null,
    amount,
    asset: row.asset,
    created_at: row.created_at,
    contributor_privacy: mode,
  };
}

function sanitizeDisplayName(displayName) {
  if (displayName === undefined || displayName === null) return null;
  const value = String(displayName).trim();
  if (!value) return null;
  return value.slice(0, 50);
}

/**
 * Change the public attribution of one of the caller's own contributions.
 * Only the contributor who made the contribution (matching wallet key) may
 * change it; the private wallet key record itself is never altered.
 */
async function setContributionAttribution({
  contributionId,
  userId,
  mode,
  displayName,
  runner = db,
} = {}) {
  const nextMode = normalizeAttributionMode(mode, 'public');

  const { rows } = await runner.query(
    `SELECT id, sender_public_key, display_name, attribution_mode
       FROM contributions
      WHERE id = $1`,
    [contributionId]
  );
  const contribution = rows[0];
  if (!contribution) {
    const error = new Error('Contribution not found');
    error.statusCode = 404;
    throw error;
  }

  const { rows: userRows } = await runner.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [userId]
  );
  const walletPublicKey = userRows[0]?.wallet_public_key;
  if (!walletPublicKey || walletPublicKey !== contribution.sender_public_key) {
    const error = new Error('Not authorized to change this contribution');
    error.statusCode = 403;
    throw error;
  }

  const nextDisplayName =
    nextMode === 'anonymous'
      ? null
      : displayName !== undefined
        ? sanitizeDisplayName(displayName)
        : contribution.display_name;

  const { rows: updated } = await runner.query(
    `UPDATE contributions
        SET attribution_mode = $1, display_name = $2
      WHERE id = $3
      RETURNING id, campaign_id, display_name, sender_public_key,
                attribution_mode, amount, asset, created_at`,
    [nextMode, nextDisplayName, contributionId]
  );

  return updated[0];
}

module.exports = {
  ATTRIBUTION_MODES,
  isAttributionMode,
  normalizeAttributionMode,
  accountPrivacyToAttributionMode,
  resolveStoredAttributionMode,
  serializePublicAttribution,
  setContributionAttribution,
};
