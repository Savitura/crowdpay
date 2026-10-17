'use strict';

/**
 * Custodial creators keep their wallet secret encrypted on this server, and
 * the server also holds the platform key. For those campaigns the 2-of-2
 * creator + platform multisig cannot stop the backend (or anyone who controls
 * it) from moving funds, because both signatures come from here.
 *
 * To bound that exposure, the server refuses to produce a creator signature
 * with a custodial key for any withdrawal above CUSTODIAL_WITHDRAWAL_LIMIT
 * (in asset units, e.g. "1000" = 1000 USDC). Larger payouts need a
 * non-custodial (Freighter) creator, who signs in their own wallet, so the
 * platform alone can never satisfy the multisig for them.
 *
 * Refunds to contributors are exempt: they return money to its source and are
 * not a way to drain a campaign to an arbitrary address.
 */

const DEFAULT_CUSTODIAL_WITHDRAWAL_LIMIT = '1000';
const STROOPS_PER_UNIT = 10_000_000n;
const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

class CustodialSigningLimitError extends Error {
  constructor(amount, limit) {
    super(
      `Withdrawals above ${limit} require the creator to sign with a non-custodial (Freighter) wallet; ` +
        `the platform will not sign ${amount} with a server-held creator key`
    );
    this.name = 'CustodialSigningLimitError';
    this.code = 'NON_CUSTODIAL_SIGNATURE_REQUIRED';
    this.statusCode = 403;
    this.amount = amount;
    this.limit = limit;
  }
}

function toStroops(value) {
  const text = String(value ?? '').trim();
  if (!AMOUNT_PATTERN.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, '0'));
}

function getCustodialWithdrawalLimit() {
  const configured = process.env.CUSTODIAL_WITHDRAWAL_LIMIT;
  if (configured !== undefined && configured !== '' && toStroops(configured) !== null) {
    return configured.trim();
  }
  return DEFAULT_CUSTODIAL_WITHDRAWAL_LIMIT;
}

function isCustodialWallet(walletType) {
  return walletType !== 'freighter';
}

/**
 * Throws CustodialSigningLimitError when the server would sign `amount` with
 * a custodial creator key above the configured limit. Amounts that cannot be
 * parsed are refused too, so a malformed value never slips past the cap.
 */
function assertCustodialWithdrawalAllowed({ walletType, amount, isRefund = false }) {
  if (isRefund || !isCustodialWallet(walletType)) return;

  const limit = getCustodialWithdrawalLimit();
  const amountStroops = toStroops(amount);
  if (amountStroops === null || amountStroops > toStroops(limit)) {
    throw new CustodialSigningLimitError(String(amount), limit);
  }
}

module.exports = {
  DEFAULT_CUSTODIAL_WITHDRAWAL_LIMIT,
  CustodialSigningLimitError,
  assertCustodialWithdrawalAllowed,
  getCustodialWithdrawalLimit,
  isCustodialWallet,
};
