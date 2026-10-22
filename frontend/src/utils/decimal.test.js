import { describe, it, expect } from 'vitest';
import {
  STELLAR_DECIMALS,
  MAX_STELLAR_AMOUNT,
  cleanDecimalInput,
  splitDecimal,
  getDecimalPlaces,
  parseDecimal,
  isValidDecimal,
  validateMonetaryInput,
  compareDecimals,
  addDecimals,
  subtractDecimals,
  calculateFeeAndNet,
  toStroops,
  fromStroops,
  formatDecimal,
  DecimalError,
} from './decimal';

describe('decimal utility', () => {
  describe('cleanDecimalInput', () => {
    it('trims whitespace', () => {
      expect(cleanDecimalInput('  12.34  ')).toBe('12.34');
    });

    it('strips valid thousand separators', () => {
      expect(cleanDecimalInput('1,000.50')).toBe('1000.50');
      expect(cleanDecimalInput('1,000,000.75')).toBe('1000000.75');
      expect(cleanDecimalInput('100,000')).toBe('100000');
    });

    it('leaves malformed comma placements to fail decimal validation', () => {
      expect(cleanDecimalInput(',100')).toBe(',100');
      expect(cleanDecimalInput('1,,000')).toBe('1,,000');
      expect(cleanDecimalInput('10,00')).toBe('10,00');
    });

    it('handles empty or nullish inputs', () => {
      expect(cleanDecimalInput('')).toBe('');
      expect(cleanDecimalInput(null)).toBe('');
      expect(cleanDecimalInput(undefined)).toBe('');
    });
  });

  describe('splitDecimal', () => {
    it('splits standard decimal values into whole and fraction parts', () => {
      expect(splitDecimal('123.45')).toEqual({
        sign: '',
        whole: '123',
        fraction: '45',
        raw: '123.45',
      });
      expect(splitDecimal('-50.001')).toEqual({
        sign: '-',
        whole: '50',
        fraction: '001',
        raw: '-50.001',
      });
      expect(splitDecimal('.5')).toEqual({
        sign: '',
        whole: '0',
        fraction: '5',
        raw: '.5',
      });
      expect(splitDecimal('5.')).toEqual({
        sign: '',
        whole: '5',
        fraction: '',
        raw: '5.',
      });
    });

    it('normalizes zero representations', () => {
      expect(splitDecimal('0')).toEqual({
        sign: '',
        whole: '0',
        fraction: '',
        raw: '0',
      });
      expect(splitDecimal('-0.000')).toEqual({
        sign: '',
        whole: '0',
        fraction: '',
        raw: '-0.000',
      });
    });

    it('handles scientific notation accurately without floating point', () => {
      expect(splitDecimal('1e-5')).toEqual({
        sign: '',
        whole: '0',
        fraction: '00001',
        raw: '1e-5',
      });
      expect(splitDecimal('2.5e3')).toEqual({
        sign: '',
        whole: '2500',
        fraction: '',
        raw: '2.5e3',
      });
    });

    it('throws DecimalError for non-numeric or malformed strings', () => {
      expect(() => splitDecimal('')).toThrow(DecimalError);
      expect(() => splitDecimal('abc')).toThrow(DecimalError);
      expect(() => splitDecimal('1.2.3')).toThrow(DecimalError);
      expect(() => splitDecimal('NaN')).toThrow(DecimalError);
      expect(() => splitDecimal('Infinity')).toThrow(DecimalError);
    });
  });

  describe('getDecimalPlaces', () => {
    it('returns exact count of fractional digits', () => {
      expect(getDecimalPlaces('10')).toBe(0);
      expect(getDecimalPlaces('10.5')).toBe(1);
      expect(getDecimalPlaces('10.1234567')).toBe(7);
      expect(getDecimalPlaces('10.12345678')).toBe(8);
      expect(getDecimalPlaces('invalid')).toBe(0);
    });
  });

  describe('parseDecimal', () => {
    it('normalizes canonical decimal strings', () => {
      expect(parseDecimal('8.29')).toBe('8.29');
      expect(parseDecimal('01.50')).toBe('1.5');
      expect(parseDecimal('0.0000001')).toBe('0.0000001');
      expect(parseDecimal('100.00')).toBe('100');
    });

    it('preserves up to specified maxDecimals (default 7)', () => {
      expect(parseDecimal('1.1234567')).toBe('1.1234567');
      // Trailing zeros beyond 7th decimal do not add precision, accepted
      expect(parseDecimal('1.5000000000')).toBe('1.5');
    });

    it('rejects more than 7 decimal places with non-zero digits', () => {
      expect(() => parseDecimal('0.00000001')).toThrow(DecimalError);
      expect(() => parseDecimal('1.12345678')).toThrow(/exceeds maximum allowed precision/);
    });

    it('enforces allowZero and allowNegative options', () => {
      expect(parseDecimal('0', { allowZero: true })).toBe('0');
      expect(() => parseDecimal('0', { allowZero: false })).toThrow(/greater than zero/);

      expect(parseDecimal('-5', { allowNegative: true })).toBe('-5');
      expect(() => parseDecimal('-5', { allowNegative: false })).toThrow(/must not be negative/);
    });
  });

  describe('isValidDecimal', () => {
    it('validates correct monetary inputs', () => {
      expect(isValidDecimal('10')).toBe(true);
      expect(isValidDecimal('10.50')).toBe(true);
      expect(isValidDecimal('0.0000001')).toBe(true);
      expect(isValidDecimal('1,000.50')).toBe(true);
      expect(isValidDecimal(10.5)).toBe(true);
    });

    it('rejects invalid monetary inputs', () => {
      expect(isValidDecimal('')).toBe(false);
      expect(isValidDecimal('   ')).toBe(false);
      expect(isValidDecimal('abc')).toBe(false);
      expect(isValidDecimal('1.2.3')).toBe(false);
      expect(isValidDecimal('0.00000001')).toBe(false); // 8 decimals
      expect(isValidDecimal('0')).toBe(false); // default allowZero: false
      expect(isValidDecimal('-1')).toBe(false); // default allowNegative: false
    });

    it('respects min and max bounds', () => {
      expect(isValidDecimal('5', { min: '5', max: '10' })).toBe(true);
      expect(isValidDecimal('10', { min: '5', max: '10' })).toBe(true);
      expect(isValidDecimal('4.9999999', { min: '5' })).toBe(false);
      expect(isValidDecimal('10.0000001', { max: '10' })).toBe(false);
    });
  });

  describe('validateMonetaryInput', () => {
    it('returns valid result for good amounts', () => {
      const res = validateMonetaryInput('15.5');
      expect(res.isValid).toBe(true);
      expect(res.error).toBeNull();
      expect(res.value).toBe('15.5');
      expect(res.numericValue).toBe(15.5);
    });

    it('returns error for empty amount', () => {
      const res = validateMonetaryInput('', { fieldName: 'Target amount' });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Enter an amount greater than zero.');
    });

    it('returns error for zero amount when disallowed', () => {
      const res = validateMonetaryInput('0', { allowZero: false });
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Enter an amount greater than zero.');
    });

    it('returns error for negative amounts', () => {
      const res = validateMonetaryInput('-5');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Amount must not be negative.');
    });

    it('returns error for excessive decimal precision (> 7 decimals)', () => {
      const res = validateMonetaryInput('1.00000008');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Amount cannot have more than 7 decimal places.');
    });

    it('returns error when exceeding Stellar max limit', () => {
      const res = validateMonetaryInput('922337203685.4775808');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Amount exceeds the maximum supported Stellar amount.');
    });

    it('accepts exact Stellar max limit', () => {
      const res = validateMonetaryInput(MAX_STELLAR_AMOUNT);
      expect(res.isValid).toBe(true);
      expect(res.error).toBeNull();
    });

    it('enforces min and max constraints with friendly error messages', () => {
      const minRes = validateMonetaryInput('2', { min: '5', fieldName: 'Contribution' });
      expect(minRes.isValid).toBe(false);
      expect(minRes.error).toBe('Contribution must be at least 5.');

      const maxRes = validateMonetaryInput('50', { max: '25', fieldName: 'Contribution' });
      expect(maxRes.isValid).toBe(false);
      expect(maxRes.error).toBe('Contribution cannot exceed 25.');
    });
  });

  describe('compareDecimals', () => {
    it('compares positive numbers correctly without floating point errors', () => {
      expect(compareDecimals('10', '5')).toBe(1);
      expect(compareDecimals('5', '10')).toBe(-1);
      expect(compareDecimals('10', '10')).toBe(0);
      expect(compareDecimals('10.0', '10')).toBe(0);
      expect(compareDecimals('0.1', '0.01')).toBe(1);
      expect(compareDecimals('0.0000002', '0.0000001')).toBe(1);
      expect(compareDecimals('9.9999999', '10')).toBe(-1);
    });

    it('compares negative numbers correctly', () => {
      expect(compareDecimals('-1', '1')).toBe(-1);
      expect(compareDecimals('1', '-1')).toBe(1);
      expect(compareDecimals('-5', '-10')).toBe(1);
      expect(compareDecimals('-10', '-5')).toBe(-1);
    });
  });

  describe('addDecimals and subtractDecimals', () => {
    it('avoids 0.1 + 0.2 floating point binary drift', () => {
      // In JS, 0.1 + 0.2 is 0.30000000000000004
      expect(addDecimals('0.1', '0.2')).toBe('0.3');
      expect(subtractDecimals('0.3', '0.2')).toBe('0.1');
    });

    it('handles exact 7-decimal additions and subtractions', () => {
      expect(addDecimals('0.0000001', '0.0000002')).toBe('0.0000003');
      expect(subtractDecimals('1.5', '0.5000001')).toBe('0.9999999');
    });
  });

  describe('calculateFeeAndNet', () => {
    it('calculates platform fee and net proceeds with half-up rounding', () => {
      // 2.5% fee on 100 XLM = 2.5 XLM fee, 97.5 XLM net
      const res = calculateFeeAndNet('100', 250);
      expect(res.feeAmount).toBe('2.5');
      expect(res.netAmount).toBe('97.5');
      expect(res.feeStroops + res.netStroops).toBe(1000000000n);
    });

    it('preserves exact stroop balance on odd amounts', () => {
      const res = calculateFeeAndNet('8.29', 250);
      // 8.29 * 250 / 10000 = 0.20725 -> 2072500 stroops
      expect(res.feeAmount).toBe('0.20725');
      expect(res.netAmount).toBe('8.08275');
      expect(res.feeStroops + res.netStroops).toBe(82900000n);
    });
  });

  describe('toStroops and fromStroops', () => {
    it('converts exact amounts to BigInt stroops', () => {
      expect(toStroops('8.29')).toBe(82900000n);
      expect(toStroops('0.0000001')).toBe(1n);
      expect(toStroops(MAX_STELLAR_AMOUNT)).toBe(2n ** 63n - 1n);
    });

    it('roundtrips accurately fromStroops', () => {
      expect(fromStroops(82900000n)).toBe('8.2900000');
      expect(fromStroops(82900000n, true)).toBe('8.29');
      expect(fromStroops(1n)).toBe('0.0000001');
    });
  });

  describe('formatDecimal', () => {
    it('formats with grouping and precision control', () => {
      expect(formatDecimal('1234567.89', { useGrouping: true })).toBe('1,234,567.89');
      expect(formatDecimal('100', { minimumFractionDigits: 2 })).toBe('100.00');
      expect(formatDecimal('100.56789', { maximumFractionDigits: 2 })).toBe('100.56');
    });
  });
});
