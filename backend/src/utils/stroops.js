/**
 * Exact decimal <-> stroop conversion for Stellar / Soroban amounts (#840).
 *
 * Stellar assets carry 7 decimal places; 1 unit = 10^7 stroops. Converting
 * with `Math.floor(parseFloat(amount) * 1e7)` goes through binary floating
 * point and drifts by a stroop for ordinary values (8.29 -> 82,899,999), so
 * every conversion here works on the decimal string and BigInt only.
 *
 * Precision rule (the single rule used everywhere): an amount must be exactly
 * representable in stroops. Digits beyond the 7th fractional place are
 * rejected unless they are all zeros ("1.50000000" is accepted, "1.00000001"
 * is rejected) — money is never silently rounded or truncated.
 *
 * Amounts leave this module as BigInt stroops (for contract calls) or as
 * canonical 7-decimal strings (for Horizon operations, API responses and
 * persistence), never as JS numbers.
 */

const STROOP_DECIMALS = 7;
const STROOPS_PER_UNIT = 10n ** BigInt(STROOP_DECIMALS);
// Stellar amounts are signed 64-bit stroop counts: 922337203685.4775807.
const MAX_STROOPS = 2n ** 63n - 1n;
const BPS_DENOMINATOR = 10000n;

class AmountError extends Error {
  constructor(message, code = 'INVALID_AMOUNT') {
    super(message);
    this.name = 'AmountError';
    this.code = code;
    this.statusCode = 400;
  }
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse a decimal amount (string, finite number or bigint of whole units)
 * into BigInt stroops.
 *
 * @param {string|number|bigint} amount
 * @param {{ allowZero?: boolean, allowNegative?: boolean }} [options]
 * @returns {bigint}
 */
function toStroops(amount, { allowZero = false, allowNegative = false } = {}) {
  let text;
  if (typeof amount === 'bigint') {
    text = amount.toString();
  } else if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new AmountError('amount must be a finite number');
    // String(n) is the shortest decimal that round-trips to this double, i.e.
    // the value the caller wrote (8.29 -> "8.29"), not the binary expansion.
    text = String(amount);
  } else if (typeof amount === 'string') {
    text = amount.trim();
  } else {
    throw new AmountError('amount must be a decimal string');
  }

  const match = DECIMAL_RE.exec(text);
  if (!match || (!match[2] && !match[3])) {
    throw new AmountError(`amount "${text}" is not a valid decimal`);
  }
  const [, sign, intPart = '', fracPart = '', expPart] = match;
  const exponent = expPart ? Number(expPart) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 64) {
    throw new AmountError(`amount "${text}" is out of range`);
  }

  // Shift the decimal point by the exponent on the digit string.
  let digits = `${intPart}${fracPart}`;
  let pointPos = intPart.length + exponent;
  if (pointPos < 0) {
    digits = '0'.repeat(-pointPos) + digits;
    pointPos = 0;
  } else if (pointPos > digits.length) {
    digits += '0'.repeat(pointPos - digits.length);
  }
  const whole = digits.slice(0, pointPos) || '0';
  const fraction = digits.slice(pointPos);

  if (fraction.length > STROOP_DECIMALS && /[^0]/.test(fraction.slice(STROOP_DECIMALS))) {
    throw new AmountError(
      `amount "${text}" has more than ${STROOP_DECIMALS} decimal places`,
      'AMOUNT_TOO_PRECISE'
    );
  }

  const magnitude =
    BigInt(whole) * STROOPS_PER_UNIT +
    BigInt(fraction.slice(0, STROOP_DECIMALS).padEnd(STROOP_DECIMALS, '0'));
  const stroops = sign === '-' ? -magnitude : magnitude;

  if (stroops < 0n && !allowNegative) {
    throw new AmountError('amount must not be negative');
  }
  if (stroops === 0n && !allowZero) {
    throw new AmountError('amount must be greater than zero');
  }
  if (stroops > MAX_STROOPS || stroops < -MAX_STROOPS) {
    throw new AmountError(
      'amount exceeds the maximum supported Stellar amount',
      'AMOUNT_TOO_LARGE'
    );
  }
  return stroops;
}

/** BigInt (or integer string) stroops -> canonical "123.4567890" decimal string. */
function fromStroops(stroops) {
  const value = BigInt(stroops);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(STROOP_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Canonicalise a decimal amount to a 7-place string (validating it). */
function normalizeAmount(amount, options) {
  return fromStroops(toStroops(amount, options));
}

/** Whether `amount` is a valid, exactly representable amount. */
function isValidAmount(amount, options) {
  try {
    toStroops(amount, options);
    return true;
  } catch (err) {
    if (err instanceof AmountError) return false;
    throw err;
  }
}

function assertBps(bps) {
  if (typeof bps !== 'bigint' && !Number.isInteger(Number(bps))) {
    throw new AmountError('basis points must be an integer', 'INVALID_BPS');
  }
  const value = BigInt(bps);
  if (value < 0n || value > BPS_DENOMINATOR) {
    throw new AmountError(`basis points must be between 0 and ${BPS_DENOMINATOR}`, 'INVALID_BPS');
  }
  return value;
}

/**
 * Split an amount into platform fee and campaign share. The fee is rounded
 * half-up to the nearest stroop and the campaign share is the exact
 * remainder, so feeStroops + campaignStroops === amountStroops always.
 */
function splitFee(amountStroops, bps) {
  const amount = BigInt(amountStroops);
  const rate = assertBps(bps);
  const feeStroops = (amount * rate + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
  return { feeStroops, campaignStroops: amount - feeStroops };
}

/** amount * bps / 10000, rounded up to the next stroop (for send maximums). */
function mulBpsCeil(amountStroops, bps) {
  const amount = BigInt(amountStroops);
  if (typeof bps !== 'bigint' && !Number.isInteger(Number(bps))) {
    throw new AmountError('basis points must be an integer', 'INVALID_BPS');
  }
  const rate = BigInt(bps);
  return (amount * rate + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

/** amount * bps / 10000, rounded down to the stroop (for payouts: never overpay). */
function mulBpsFloor(amountStroops, bps) {
  const amount = BigInt(amountStroops);
  if (amount < 0n) throw new AmountError('amount must not be negative');
  return (amount * assertBps(bps)) / BPS_DENOMINATOR;
}

/**
 * Exact three-way comparison of two decimal amounts (strings, numbers or
 * BigInt stroops are all accepted as in toStroops). Returns -1, 0 or 1.
 * Zero and negative values are allowed so balances and differences compare.
 */
function compareAmounts(a, b) {
  const opts = { allowZero: true, allowNegative: true };
  const x = toStroops(a, opts);
  const y = toStroops(b, opts);
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/**
 * Strict percentage -> integer basis points ("12.5" -> 1250, "100" -> 10000).
 *
 * The percentage is parsed as a decimal string, never through floating point,
 * and must land exactly on a basis point: "12.34" and "12.3400" are accepted,
 * "12.345" is rejected rather than rounded, because a rounded split no longer
 * sums to the 10000 bps total the contracts enforce.
 *
 * @param {string|number} percentage  0..100 inclusive
 * @returns {number} integer basis points, 0..10000
 */
function percentToBps(percentage) {
  let scaled;
  try {
    scaled = toStroops(percentage, { allowZero: true });
  } catch (err) {
    if (!(err instanceof AmountError)) throw err;
    throw new AmountError(
      `percentage "${percentage}" is not a valid non-negative decimal`,
      'INVALID_PERCENTAGE'
    );
  }
  // 1 bps = 0.01% = 10^5 units at 7-decimal scale.
  const perBps = STROOPS_PER_UNIT / 100n;
  if (scaled % perBps !== 0n) {
    throw new AmountError(
      `percentage "${percentage}" is finer than a basis point (max 2 decimal places)`,
      'INVALID_PERCENTAGE'
    );
  }
  const bps = scaled / perBps;
  if (bps > BPS_DENOMINATOR) {
    throw new AmountError(
      `percentage "${percentage}" must be between 0 and 100`,
      'INVALID_PERCENTAGE'
    );
  }
  return Number(bps);
}

const RATE_DECIMALS = 15;

/**
 * Exact ratio numerator / denominator of two decimal amounts, rounded half-up
 * to `scale` fractional digits, returned as a minimal decimal string
 * ("1.05", "2", "0.333333333333333"). Used for exchange / conversion rates;
 * the default scale matches the NUMERIC(30, 15) rate columns.
 */
function divideAmounts(numerator, denominator, scale = RATE_DECIMALS) {
  const n = toStroops(numerator, { allowZero: true });
  const d = toStroops(denominator);
  const factor = 10n ** BigInt(scale);
  const q = (n * factor * 2n + d) / (2n * d);
  const whole = (q / factor).toString();
  const fraction = (q % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

module.exports = {
  STROOP_DECIMALS,
  RATE_DECIMALS,
  STROOPS_PER_UNIT,
  MAX_STROOPS,
  AmountError,
  toStroops,
  fromStroops,
  normalizeAmount,
  isValidAmount,
  splitFee,
  mulBpsCeil,
  mulBpsFloor,
  compareAmounts,
  percentToBps,
  divideAmounts,
};
