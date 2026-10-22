/**
 * Centralized decimal parsing, validation, and arithmetic for monetary inputs.
 *
 * Stellar assets carry at most 7 decimal places; 1 unit = 10^7 stroops.
 * Using JavaScript's IEEE 754 floating point (parseFloat, Number) introduces
 * binary rounding errors (e.g. 8.29 * 1e7 = 82899999.99999999).
 *
 * This module ensures exact decimal parsing and validation using string manipulation
 * and BigInt arithmetic, preventing silent rounding, truncation, or precision loss.
 */

export const STELLAR_DECIMALS = 7;
export const DEFAULT_DECIMALS = 7;
export const MAX_STELLAR_AMOUNT = '922337203685.4775807';
export const MIN_POSITIVE_STELLAR_AMOUNT = '0.0000001';
export const MAX_STROOPS = 2n ** 63n - 1n; // 9223372036854775807n
export const STROOPS_PER_UNIT = 10n ** BigInt(STELLAR_DECIMALS);

const DECIMAL_REGEX = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const THOUSANDS_SEPARATOR_REGEX = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

export class DecimalError extends Error {
  constructor(message, code = 'INVALID_DECIMAL') {
    super(message);
    this.name = 'DecimalError';
    this.code = code;
  }
}

/**
 * Remove optional valid comma thousands separators and trim whitespace.
 * e.g. "1,000,500.25" -> "1000500.25"
 * If commas are present in an invalid format (e.g. "1,,000" or ",100"), returns input as-is to fail regex.
 */
export function cleanDecimalInput(value) {
  if (value === null || value === undefined) return '';
  let str = String(value).trim();
  if (str.includes(',')) {
    // If it matches standard thousands grouping, strip commas
    const withoutSign = str.startsWith('+') || str.startsWith('-') ? str.slice(1) : str;
    if (THOUSANDS_SEPARATOR_REGEX.test(withoutSign)) {
      str = str.replace(/,/g, '');
    }
  }
  return str;
}

/**
 * Split a decimal input into sign, whole, and fractional digit strings without float conversion.
 * Handles scientific notation (e.g. 1e-4) purely via string digit manipulation.
 *
 * @param {string|number|bigint} value
 * @returns {{ sign: string, whole: string, fraction: string, raw: string }}
 */
export function splitDecimal(value) {
  const text = cleanDecimalInput(value);
  if (!text) {
    throw new DecimalError('Amount cannot be empty', 'EMPTY_AMOUNT');
  }

  const match = DECIMAL_REGEX.exec(text);
  if (!match || (!match[2] && !match[3])) {
    throw new DecimalError(`Amount "${text}" is not a valid decimal`, 'INVALID_FORMAT');
  }

  const [, rawSign = '', intPart = '', fracPart = '', expPart] = match;
  const exponent = expPart ? Number(expPart) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 64) {
    throw new DecimalError(`Amount "${text}" exponent is out of range`, 'EXPONENT_OUT_OF_RANGE');
  }

  // Shift digits according to exponent
  let digits = `${intPart}${fracPart}`;
  let pointPos = intPart.length + exponent;

  if (pointPos < 0) {
    digits = '0'.repeat(-pointPos) + digits;
    pointPos = 0;
  } else if (pointPos > digits.length) {
    digits += '0'.repeat(pointPos - digits.length);
  }

  let whole = digits.slice(0, pointPos).replace(/^0+/, '') || '0';
  let fraction = digits.slice(pointPos);

  const sign = rawSign === '-' ? '-' : '';

  // Handle case where digits are all zero: normalize -0 to 0
  if (whole === '0' && /^0*$/.test(fraction)) {
    return { sign: '', whole: '0', fraction: fraction.replace(/0+$/, ''), raw: text };
  }

  return { sign, whole, fraction, raw: text };
}

/**
 * Count the number of significant fractional digits after the decimal point.
 * Trailing zeros that exceed maxDecimals are considered extra precision unless ignored.
 *
 * @param {string|number} value
 * @returns {number}
 */
export function getDecimalPlaces(value) {
  try {
    const { fraction } = splitDecimal(value);
    return fraction.length;
  } catch (_err) {
    return 0;
  }
}

/**
 * Safely parse an amount into a canonical normalized decimal string.
 *
 * @param {string|number|bigint} value
 * @param {object} [options]
 * @param {number} [options.maxDecimals=7]
 * @param {boolean} [options.allowZero=true]
 * @param {boolean} [options.allowNegative=false]
 * @param {boolean} [options.trimTrailingZeros=true]
 * @returns {string} Normalized canonical decimal string (e.g. "123.45")
 */
export function parseDecimal(
  value,
  {
    maxDecimals = STELLAR_DECIMALS,
    allowZero = true,
    allowNegative = false,
    trimTrailingZeros = true,
  } = {}
) {
  const { sign, whole, fraction, raw } = splitDecimal(value);

  const isZero = whole === '0' && /^0*$/.test(fraction);

  if (sign === '-' && !allowNegative && !isZero) {
    throw new DecimalError('Amount must not be negative', 'NEGATIVE_AMOUNT');
  }

  if (isZero && !allowZero) {
    throw new DecimalError('Amount must be greater than zero', 'ZERO_AMOUNT');
  }

  // Precision check: fraction beyond maxDecimals must not contain non-zero digits
  if (fraction.length > maxDecimals) {
    const significantExtra = fraction.slice(maxDecimals);
    if (/[^0]/.test(significantExtra)) {
      throw new DecimalError(
        `Amount "${raw}" exceeds maximum allowed precision of ${maxDecimals} decimal places`,
        'TOO_MANY_DECIMALS'
      );
    }
  }

  let effectiveFraction = fraction.slice(0, maxDecimals);
  if (trimTrailingZeros) {
    effectiveFraction = effectiveFraction.replace(/0+$/, '');
  }

  if (!effectiveFraction) {
    return `${sign}${whole}`;
  }

  return `${sign}${whole}.${effectiveFraction}`;
}

/**
 * Return true if the value represents a valid decimal according to options.
 *
 * @param {string|number|bigint} value
 * @param {object} [options]
 * @returns {boolean}
 */
export function isValidDecimal(
  value,
  { maxDecimals = STELLAR_DECIMALS, allowZero = false, allowNegative = false, min, max } = {}
) {
  try {
    const normalized = parseDecimal(value, {
      maxDecimals,
      allowZero,
      allowNegative,
    });
    if (min !== undefined && min !== null && min !== '') {
      if (compareDecimals(normalized, min) < 0) return false;
    }
    if (max !== undefined && max !== null && max !== '') {
      if (compareDecimals(normalized, max) > 0) return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Validate monetary input for form controls, returning a structured result with user-friendly error messages.
 *
 * @param {string|number} value
 * @param {object} [options]
 * @param {string} [options.fieldName='Amount']
 * @param {number} [options.maxDecimals=7]
 * @param {boolean} [options.allowZero=false]
 * @param {boolean} [options.allowNegative=false]
 * @param {string|number} [options.min]
 * @param {string|number} [options.max]
 * @param {boolean} [options.required=true]
 * @returns {{ isValid: boolean, error: string | null, value: string, numericValue: number }}
 */
export function validateMonetaryInput(
  value,
  {
    fieldName = 'Amount',
    maxDecimals = STELLAR_DECIMALS,
    allowZero = false,
    allowNegative = false,
    min,
    max,
    required = true,
  } = {}
) {
  const raw = cleanDecimalInput(value);

  if (!raw) {
    if (!required) {
      return { isValid: true, error: null, value: '', numericValue: 0 };
    }
    return {
      isValid: false,
      error: allowZero ? `${fieldName} is required.` : `Enter an amount greater than zero.`,
      value: '',
      numericValue: 0,
    };
  }

  let split;
  try {
    split = splitDecimal(raw);
  } catch (_err) {
    return {
      isValid: false,
      error: `${fieldName} is not a valid number.`,
      value: raw,
      numericValue: NaN,
    };
  }

  const isZero = split.whole === '0' && /^0*$/.test(split.fraction);

  if (split.sign === '-' && !allowNegative && !isZero) {
    return {
      isValid: false,
      error: `${fieldName} must not be negative.`,
      value: raw,
      numericValue: -Math.abs(Number(raw)),
    };
  }

  if (isZero && !allowZero) {
    return {
      isValid: false,
      error: `Enter an amount greater than zero.`,
      value: raw,
      numericValue: 0,
    };
  }

  if (split.fraction.length > maxDecimals) {
    const extra = split.fraction.slice(maxDecimals);
    if (/[^0]/.test(extra)) {
      return {
        isValid: false,
        error: `${fieldName} cannot have more than ${maxDecimals} decimal places.`,
        value: raw,
        numericValue: Number(raw),
      };
    }
  }

  const normalized = parseDecimal(raw, {
    maxDecimals,
    allowZero,
    allowNegative,
    trimTrailingZeros: true,
  });

  // Check Stellar upper limit if using Stellar decimals (7)
  if (maxDecimals === STELLAR_DECIMALS) {
    if (compareDecimals(normalized, MAX_STELLAR_AMOUNT) > 0) {
      return {
        isValid: false,
        error: `${fieldName} exceeds the maximum supported Stellar amount.`,
        value: normalized,
        numericValue: Number(normalized),
      };
    }
  }

  if (min !== undefined && min !== null && min !== '') {
    if (compareDecimals(normalized, min) < 0) {
      return {
        isValid: false,
        error: `${fieldName} must be at least ${min}.`,
        value: normalized,
        numericValue: Number(normalized),
      };
    }
  }

  if (max !== undefined && max !== null && max !== '') {
    if (compareDecimals(normalized, max) > 0) {
      return {
        isValid: false,
        error: `${fieldName} cannot exceed ${max}.`,
        value: normalized,
        numericValue: Number(normalized),
      };
    }
  }

  return {
    isValid: true,
    error: null,
    value: normalized,
    numericValue: Number(normalized),
  };
}

/**
 * Compare two decimal strings/numbers numerically without floating-point precision loss.
 *
 * @param {string|number|bigint} a
 * @param {string|number|bigint} b
 * @returns {1 | -1 | 0} 1 if a > b, -1 if a < b, 0 if a == b
 */
export function compareDecimals(a, b) {
  const da = splitDecimal(a);
  const db = splitDecimal(b);

  const aIsZero = da.whole === '0' && /^0*$/.test(da.fraction);
  const bIsZero = db.whole === '0' && /^0*$/.test(db.fraction);

  if (aIsZero && bIsZero) return 0;

  // Sign differences
  if (da.sign === '-' && db.sign !== '-') return -1;
  if (da.sign !== '-' && db.sign === '-') return 1;

  const negative = da.sign === '-';

  // Compare whole parts by length first, then lexicographically
  let cmp = 0;
  if (da.whole.length > db.whole.length) cmp = 1;
  else if (da.whole.length < db.whole.length) cmp = -1;
  else if (da.whole > db.whole) cmp = 1;
  else if (da.whole < db.whole) cmp = -1;

  if (cmp === 0) {
    // Compare fractional parts padded to equal length
    const maxFracLen = Math.max(da.fraction.length, db.fraction.length);
    const fracA = da.fraction.padEnd(maxFracLen, '0');
    const fracB = db.fraction.padEnd(maxFracLen, '0');
    if (fracA > fracB) cmp = 1;
    else if (fracA < fracB) cmp = -1;
  }

  return negative ? (-cmp === 0 ? 0 : -cmp > 0 ? 1 : -1) : cmp;
}

/**
 * Convert a decimal amount to BigInt stroops (1 unit = 10^7 stroops).
 *
 * @param {string|number|bigint} amount
 * @param {object} [options]
 * @returns {bigint}
 */
export function toStroops(amount, { allowZero = false, allowNegative = false } = {}) {
  const { sign, whole, fraction, raw } = splitDecimal(amount);
  const isZero = whole === '0' && /^0*$/.test(fraction);

  if (sign === '-' && !allowNegative && !isZero) {
    throw new DecimalError('Amount must not be negative', 'NEGATIVE_AMOUNT');
  }

  if (isZero && !allowZero) {
    throw new DecimalError('Amount must be greater than zero', 'ZERO_AMOUNT');
  }

  if (fraction.length > STELLAR_DECIMALS) {
    const extra = fraction.slice(STELLAR_DECIMALS);
    if (/[^0]/.test(extra)) {
      throw new DecimalError(
        `Amount "${raw}" has more than ${STELLAR_DECIMALS} decimal places`,
        'AMOUNT_TOO_PRECISE'
      );
    }
  }

  const paddedFrac = fraction.slice(0, STELLAR_DECIMALS).padEnd(STELLAR_DECIMALS, '0');
  const magnitude = BigInt(whole) * STROOPS_PER_UNIT + BigInt(paddedFrac);
  const stroops = sign === '-' ? -magnitude : magnitude;

  if (stroops > MAX_STROOPS || stroops < -MAX_STROOPS) {
    throw new DecimalError(
      'Amount exceeds the maximum supported Stellar amount',
      'AMOUNT_TOO_LARGE'
    );
  }

  return stroops;
}

/**
 * Convert BigInt stroops back to a canonical 7-decimal string.
 *
 * @param {bigint|string|number} stroops
 * @param {boolean} [trimTrailing=false]
 * @returns {string}
 */
export function fromStroops(stroops, trimTrailing = false) {
  const value = BigInt(stroops);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_UNIT;
  let fraction = (abs % STROOPS_PER_UNIT).toString().padStart(STELLAR_DECIMALS, '0');

  if (trimTrailing) {
    fraction = fraction.replace(/0+$/, '');
    if (!fraction) return `${negative ? '-' : ''}${whole}`;
  }

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Add two decimal values safely using stroops.
 */
export function addDecimals(a, b) {
  const sum =
    toStroops(a, { allowZero: true, allowNegative: true }) +
    toStroops(b, { allowZero: true, allowNegative: true });
  return fromStroops(sum, true);
}

/**
 * Subtract b from a safely using stroops.
 */
export function subtractDecimals(a, b) {
  const diff =
    toStroops(a, { allowZero: true, allowNegative: true }) -
    toStroops(b, { allowZero: true, allowNegative: true });
  return fromStroops(diff, true);
}

/**
 * Split an amount into platform fee and remainder using exact basis-point rounding half-up.
 *
 * @param {string|number|bigint} amount
 * @param {number|bigint} bps
 * @returns {{ feeAmount: string, netAmount: string, feeStroops: bigint, netStroops: bigint }}
 */
export function calculateFeeAndNet(amount, bps) {
  const amountStroops = toStroops(amount, { allowZero: true });
  const bpsBig = BigInt(bps);
  const BPS_DENOMINATOR = 10000n;
  const feeStroops = (amountStroops * bpsBig + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
  const netStroops = amountStroops - feeStroops;

  return {
    feeAmount: fromStroops(feeStroops, true),
    netAmount: fromStroops(netStroops, true),
    feeStroops,
    netStroops,
  };
}

/**
 * Format a decimal value for user display with optional thousand grouping and decimal bounds.
 *
 * @param {string|number|bigint} value
 * @param {object} [options]
 * @param {number} [options.minimumFractionDigits=0]
 * @param {number} [options.maximumFractionDigits=7]
 * @param {boolean} [options.useGrouping=false]
 * @returns {string}
 */
export function formatDecimal(
  value,
  { minimumFractionDigits = 0, maximumFractionDigits = STELLAR_DECIMALS, useGrouping = false } = {}
) {
  if (value === null || value === undefined || value === '') return '';
  try {
    const { sign, whole, fraction } = splitDecimal(value);
    let frac = fraction.slice(0, maximumFractionDigits);

    // Pad if shorter than minimumFractionDigits
    if (frac.length < minimumFractionDigits) {
      frac = frac.padEnd(minimumFractionDigits, '0');
    } else {
      // Remove trailing zeros beyond minimumFractionDigits
      while (frac.length > minimumFractionDigits && frac.endsWith('0')) {
        frac = frac.slice(0, -1);
      }
    }

    let wholeFormatted = whole;
    if (useGrouping) {
      wholeFormatted = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    return frac.length > 0 ? `${sign}${wholeFormatted}.${frac}` : `${sign}${wholeFormatted}`;
  } catch (_err) {
    return String(value);
  }
}
