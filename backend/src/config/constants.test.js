const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('./constants');

const {
  TX_TIMEOUT_CONTRIBUTION_S,
  TX_TIMEOUT_WITHDRAWAL_S,
  MULTISIG_STANDARD_THRESHOLDS,
  MULTISIG_DISPUTE_FROZEN_THRESHOLDS,
  MULTISIG_DISPUTE_RELEASED_THRESHOLDS,
  MULTISIG_CLEANUP_THRESHOLDS,
  MULTISIG_SIGNER_WEIGHT,
  MULTISIG_SIGNER_WEIGHT_REMOVE,
  MULTISIG_MASTER_WEIGHT_DISABLED,
  SLIPPAGE_BPS,
  CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM,
  CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM,
  LEDGER_MONITOR_RECONNECT_DELAY_MS,
  STELLAR_ASSET_DECIMALS_SCALE,
  MILESTONE_LIMIT,
  MILESTONE_EVIDENCE_MAX_FILE_SIZE,
  MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS,
  MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS,
  MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S,
  MAX_UPLOAD_SIZE,
  ALLOWED_UPLOAD_MIME_TYPES,
  IMPERSONATION_TTL_SECONDS,
  ADMIN_AUDIT_LOG_MAX_LIMIT,
  IMPACT_CACHE_TTL_SECONDS,
} = constants;

const MB = 1024 * 1024;

test('constants: every exported value is defined', () => {
  for (const [name, value] of Object.entries(constants)) {
    assert.notEqual(value, undefined, `${name} is undefined`);
    assert.notEqual(value, null, `${name} is null`);
  }
});

test('constants: timeouts, TTLs, limits and sizes are positive finite numbers', () => {
  const positive = {
    TX_TIMEOUT_CONTRIBUTION_S,
    TX_TIMEOUT_WITHDRAWAL_S,
    SLIPPAGE_BPS,
    CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM,
    CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM,
    LEDGER_MONITOR_RECONNECT_DELAY_MS,
    STELLAR_ASSET_DECIMALS_SCALE,
    MILESTONE_LIMIT,
    MILESTONE_EVIDENCE_MAX_FILE_SIZE,
    MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS,
    MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS,
    MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S,
    MAX_UPLOAD_SIZE,
    IMPERSONATION_TTL_SECONDS,
    ADMIN_AUDIT_LOG_MAX_LIMIT,
    IMPACT_CACHE_TTL_SECONDS,
  };
  for (const [name, value] of Object.entries(positive)) {
    assert.equal(typeof value, 'number', `${name} must be a number`);
    assert.ok(Number.isFinite(value) && value > 0, `${name} must be > 0 (got ${value})`);
  }
});

test('constants: count, size, second and millisecond values are integers', () => {
  const integers = {
    TX_TIMEOUT_CONTRIBUTION_S,
    TX_TIMEOUT_WITHDRAWAL_S,
    SLIPPAGE_BPS,
    LEDGER_MONITOR_RECONNECT_DELAY_MS,
    STELLAR_ASSET_DECIMALS_SCALE,
    MILESTONE_LIMIT,
    MILESTONE_EVIDENCE_MAX_FILE_SIZE,
    MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS,
    MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS,
    MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S,
    MAX_UPLOAD_SIZE,
    IMPERSONATION_TTL_SECONDS,
    ADMIN_AUDIT_LOG_MAX_LIMIT,
    IMPACT_CACHE_TTL_SECONDS,
  };
  for (const [name, value] of Object.entries(integers)) {
    assert.ok(Number.isSafeInteger(value), `${name} must be an integer (got ${value})`);
  }
});

test('constants: Stellar transaction timeouts', () => {
  assert.equal(TX_TIMEOUT_CONTRIBUTION_S, 30);
  assert.equal(TX_TIMEOUT_WITHDRAWAL_S, 7 * 24 * 60 * 60, 'withdrawals stay valid for 7 days');
  assert.ok(TX_TIMEOUT_WITHDRAWAL_S > TX_TIMEOUT_CONTRIBUTION_S);
  assert.ok(MILESTONE_AUTO_RELEASE_TX_TIMEOUT_S < TX_TIMEOUT_WITHDRAWAL_S);
});

test('constants: slippage cap is a sane basis-point value (fee/slippage cap)', () => {
  assert.equal(SLIPPAGE_BPS, 500);
  assert.ok(SLIPPAGE_BPS > 0 && SLIPPAGE_BPS < 10_000, 'must stay below 100%');
});

test('constants: Stellar amount scale matches 7 decimal places', () => {
  assert.equal(STELLAR_ASSET_DECIMALS_SCALE, 10 ** 7);
});

test('constants: custodial reserves cover the Stellar minimum balance', () => {
  // Stellar base reserve is 0.5 XLM; an account needs 2 base reserves (1 XLM)
  // and each trustline adds one more base reserve.
  assert.ok(CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM >= 1);
  assert.ok(CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM >= 0.5);
});

test('constants: standard multisig requires creator + platform for payments', () => {
  const { masterWeight, lowThreshold, medThreshold, highThreshold } = MULTISIG_STANDARD_THRESHOLDS;
  assert.equal(masterWeight, MULTISIG_MASTER_WEIGHT_DISABLED, 'master key is disabled');
  assert.ok(lowThreshold <= medThreshold && medThreshold <= highThreshold);
  assert.equal(medThreshold, 2 * MULTISIG_SIGNER_WEIGHT, 'two signers needed for payments');
  // A single signer must never be enough to move funds.
  assert.ok(MULTISIG_SIGNER_WEIGHT < medThreshold);
});

test('constants: dispute freeze needs every signer and release restores standard thresholds', () => {
  assert.equal(MULTISIG_DISPUTE_FROZEN_THRESHOLDS.medThreshold, 3 * MULTISIG_SIGNER_WEIGHT);
  assert.equal(MULTISIG_DISPUTE_FROZEN_THRESHOLDS.highThreshold, 3 * MULTISIG_SIGNER_WEIGHT);
  assert.ok(
    MULTISIG_DISPUTE_FROZEN_THRESHOLDS.medThreshold > MULTISIG_STANDARD_THRESHOLDS.medThreshold
  );
  assert.ok(
    MULTISIG_DISPUTE_FROZEN_THRESHOLDS.medThreshold <=
      MULTISIG_DISPUTE_FROZEN_THRESHOLDS.highThreshold
  );
  assert.equal(
    MULTISIG_DISPUTE_RELEASED_THRESHOLDS.medThreshold,
    MULTISIG_STANDARD_THRESHOLDS.medThreshold
  );
  assert.equal(
    MULTISIG_DISPUTE_RELEASED_THRESHOLDS.highThreshold,
    MULTISIG_STANDARD_THRESHOLDS.highThreshold
  );
});

test('constants: cleanup thresholds let a single signer sweep the account', () => {
  for (const [name, value] of Object.entries(MULTISIG_CLEANUP_THRESHOLDS)) {
    assert.equal(value, MULTISIG_SIGNER_WEIGHT, `${name} must equal one signer weight`);
  }
});

test('constants: all multisig thresholds are within the Stellar 0-255 range', () => {
  for (const group of [
    MULTISIG_STANDARD_THRESHOLDS,
    MULTISIG_DISPUTE_FROZEN_THRESHOLDS,
    MULTISIG_DISPUTE_RELEASED_THRESHOLDS,
    MULTISIG_CLEANUP_THRESHOLDS,
  ]) {
    for (const [name, value] of Object.entries(group)) {
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 255, `${name}=${value}`);
    }
  }
  assert.equal(MULTISIG_SIGNER_WEIGHT_REMOVE, 0, 'weight 0 removes a signer');
  assert.equal(MULTISIG_MASTER_WEIGHT_DISABLED, 0, 'weight 0 disables the master key');
});

test('constants: milestone auto-release default window is never below the floor', () => {
  assert.equal(MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS, 24 * 60 * 60);
  assert.equal(MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS, 72 * 60 * 60);
  assert.ok(
    MILESTONE_AUTO_RELEASE_DEFAULT_WINDOW_SECONDS >= MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS
  );
});

test('constants: upload limits', () => {
  assert.equal(MILESTONE_LIMIT, 5);
  assert.equal(MAX_UPLOAD_SIZE, 5 * MB);
  assert.equal(MILESTONE_EVIDENCE_MAX_FILE_SIZE, 10 * MB);
  assert.ok(Array.isArray(ALLOWED_UPLOAD_MIME_TYPES) && ALLOWED_UPLOAD_MIME_TYPES.length > 0);
  assert.equal(new Set(ALLOWED_UPLOAD_MIME_TYPES).size, ALLOWED_UPLOAD_MIME_TYPES.length);
  for (const mime of ALLOWED_UPLOAD_MIME_TYPES) {
    assert.match(mime, /^image\/[a-z0-9.+-]+$/, `${mime} must be an image MIME type`);
  }
  assert.ok(!ALLOWED_UPLOAD_MIME_TYPES.includes('image/svg+xml'), 'SVG can carry scripts');
});

test('constants: admin and cache limits', () => {
  assert.equal(IMPERSONATION_TTL_SECONDS, 15 * 60);
  assert.ok(IMPERSONATION_TTL_SECONDS <= 60 * 60, 'impersonation tokens stay short-lived');
  assert.equal(ADMIN_AUDIT_LOG_MAX_LIMIT, 1000);
  assert.equal(IMPACT_CACHE_TTL_SECONDS, 60);
});
