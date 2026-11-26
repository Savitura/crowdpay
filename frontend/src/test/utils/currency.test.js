import { describe, it, expect } from 'vitest';
import {
  formatNaira,
  formatApproxNaira,
  getRateForAsset,
  DEFAULT_NGN_RATES,
} from '../../utils/currency';

describe('currency utilities (NGN / Naira)', () => {
  it('formats whole Naira amounts with comma separation', () => {
    // 100 USDC * 1600 = 160,000
    expect(formatNaira(100, 1600)).toBe('160,000');
    // 1000 USDC * 1600 = 1,600,000
    expect(formatNaira(1000, 1600)).toBe('1,600,000');
  });

  it('formats approximate Naira string clearly marked as approximate', () => {
    expect(formatApproxNaira(100, 1600)).toBe('≈ ₦160,000 approx.');
    expect(formatApproxNaira(1000, 1600)).toBe('≈ ₦1,600,000 approx.');
  });

  it('handles invalid or zero amounts gracefully', () => {
    expect(formatNaira(0, 1600)).toBeNull();
    expect(formatNaira(-10, 1600)).toBeNull();
    expect(formatNaira(-0.01, 1600)).toBeNull();
    expect(formatNaira('-50', 1600)).toBeNull();
    expect(formatNaira('invalid', 1600)).toBeNull();
    expect(formatNaira(NaN, 1600)).toBeNull();
    expect(formatNaira(Infinity, 1600)).toBeNull();
    expect(formatNaira(-Infinity, 1600)).toBeNull();
    expect(formatNaira(null, 1600)).toBeNull();
    expect(formatNaira(undefined, 1600)).toBeNull();
    expect(formatNaira('', 1600)).toBeNull();
    expect(formatNaira('   ', 1600)).toBeNull();
    expect(formatApproxNaira(0, 1600)).toBeNull();
    expect(formatApproxNaira(-10, 1600)).toBeNull();
    expect(formatApproxNaira('invalid', 1600)).toBeNull();
    expect(formatApproxNaira(NaN, 1600)).toBeNull();
    expect(formatApproxNaira(Infinity, 1600)).toBeNull();
    expect(formatApproxNaira(null, 1600)).toBeNull();
    expect(formatApproxNaira(undefined, 1600)).toBeNull();
  });

  it('parses numeric string amounts', () => {
    expect(formatNaira('100', 1600)).toBe('160,000');
    expect(formatNaira('0.5', 1600)).toBe('800');
  });

  it('falls back to DEFAULT_NGN_RATES.USDC when rate is missing or invalid', () => {
    expect(formatNaira(1)).toBe('1,600');
    expect(formatNaira(1, undefined)).toBe('1,600');
    expect(formatNaira(1, null)).toBe('1,600');
    expect(formatNaira(1, 0)).toBe('1,600');
    expect(formatNaira(1, NaN)).toBe('1,600');
    expect(formatNaira(1, 'invalid')).toBe('1,600');
    expect(formatApproxNaira(1)).toBe('≈ ₦1,600 approx.');
    expect(formatApproxNaira(1, NaN)).toBe('≈ ₦1,600 approx.');
  });

  it('formats sub-100 NGN amounts with up to 2 decimals and rounds at >= 100', () => {
    expect(formatNaira(0.05, 1600)).toBe('80');
    expect(formatNaira(0.01234, 1000)).toBe('12.34');
    expect(formatApproxNaira(0.01234, 1000)).toBe('≈ ₦12.34 approx.');
    expect(formatNaira(0.0625, 1600)).toBe('100');
    expect(formatNaira(0.1056, 1000)).toBe('106');
  });

  it('resolves rate for USDC and XLM and handles missing/nested rates', () => {
    const customRates = { USDC: 1500, XLM: 150 };
    expect(getRateForAsset(customRates, 'USDC')).toBe(1500);
    expect(getRateForAsset(customRates, 'usdc')).toBe(1500);
    expect(getRateForAsset(customRates, 'XLM')).toBe(150);
    expect(getRateForAsset(customRates)).toBe(1500);
    expect(getRateForAsset({ USDC: 1500 }, 'XLM')).toBe(DEFAULT_NGN_RATES.XLM);
    expect(getRateForAsset({ rates: { XLM: 200 } }, 'xlm')).toBe(200);
    expect(getRateForAsset({}, 'EUR')).toBe(DEFAULT_NGN_RATES.USDC);
    expect(getRateForAsset(null, 'USDC')).toBe(DEFAULT_NGN_RATES.USDC);
    expect(getRateForAsset(undefined, 'XLM')).toBe(DEFAULT_NGN_RATES.XLM);
    expect(getRateForAsset('invalid', 'USD')).toBe(DEFAULT_NGN_RATES.USD);
    expect(getRateForAsset(null, 'EUR')).toBe(DEFAULT_NGN_RATES.USDC);
    expect(getRateForAsset(null, '')).toBe(DEFAULT_NGN_RATES.USDC);
  });
});
