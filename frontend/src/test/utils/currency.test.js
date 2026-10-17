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
    expect(formatNaira('invalid', 1600)).toBeNull();
    expect(formatApproxNaira(0, 1600)).toBeNull();
    expect(formatApproxNaira('invalid', 1600)).toBeNull();
  });

  it('resolves rate for USDC and XLM', () => {
    const customRates = { USDC: 1500, XLM: 150 };
    expect(getRateForAsset(customRates, 'USDC')).toBe(1500);
    expect(getRateForAsset(customRates, 'usdc')).toBe(1500);
    expect(getRateForAsset(customRates, 'XLM')).toBe(150);
    expect(getRateForAsset(null, 'USDC')).toBe(DEFAULT_NGN_RATES.USDC);
  });
});
