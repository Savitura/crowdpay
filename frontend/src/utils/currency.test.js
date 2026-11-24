import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NGN_RATES,
  formatApproxNaira,
  formatNaira,
  getRateForAsset,
} from './currency';

describe('currency utilities', () => {
  describe('getRateForAsset', () => {
    it('resolves direct, nested, and case-insensitive rates', () => {
      expect(getRateForAsset({ USDC: 1700, XLM: 200 }, 'xlm')).toBe(200);
      expect(getRateForAsset({ rates: { XLM: 185 } }, 'XLM')).toBe(185);
    });

    it('falls back to DEFAULT_NGN_RATES when rates are missing or invalid', () => {
      expect(getRateForAsset(null, 'XLM')).toBe(DEFAULT_NGN_RATES.XLM);
      expect(getRateForAsset(undefined, 'USDC')).toBe(DEFAULT_NGN_RATES.USDC);
      expect(getRateForAsset('invalid', 'UNKNOWN')).toBe(DEFAULT_NGN_RATES.USDC);
      expect(getRateForAsset({}, 'UNKNOWN')).toBe(DEFAULT_NGN_RATES.USDC);
    });
  });

  describe('formatNaira', () => {
    it('returns null for NaN, non-finite, zero, negative, or missing amounts', () => {
      for (const bad of [NaN, Infinity, -Infinity, 0, -1, -0.01, '', 'abc', null, undefined]) {
        expect(formatNaira(bad, 1600)).toBeNull();
      }
    });

    it('rounds values >= 100 and keeps up to 2 decimals below 100', () => {
      expect(formatNaira(1000, 1600)).toBe('1,600,000');
      expect(formatNaira(0.5, 160)).toBe('80');
      expect(formatNaira(0.123, 100)).toBe('12.3');
    });

    it('falls back to DEFAULT_NGN_RATES.USDC when rate is missing or invalid', () => {
      expect(formatNaira(1, undefined)).toBe('1,600');
      expect(formatNaira(1, NaN)).toBe('1,600');
      expect(formatNaira(1, 0)).toBe('1,600');
      expect(formatNaira(1, 'invalid')).toBe('1,600');
    });
  });

  describe('formatApproxNaira', () => {
    it('formats valid amounts and returns null for invalid ones', () => {
      expect(formatApproxNaira(1000, 1600)).toBe('≈ ₦1,600,000 approx.');
      expect(formatApproxNaira(0, 1600)).toBeNull();
      expect(formatApproxNaira(-5, 1600)).toBeNull();
      expect(formatApproxNaira(NaN, 1600)).toBeNull();
    });
  });
});
