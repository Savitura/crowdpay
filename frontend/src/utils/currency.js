export const DEFAULT_NGN_RATES = {
  USDC: 1600,
  USD: 1600,
  XLM: 160,
};

/**
 * Resolve the NGN exchange rate for a given asset type (e.g. 'USDC', 'XLM').
 */
export function getRateForAsset(rates, assetType = 'USDC') {
  if (!rates || typeof rates !== 'object') {
    return DEFAULT_NGN_RATES[assetType?.toUpperCase()] || DEFAULT_NGN_RATES.USDC;
  }
  const code = (assetType || 'USDC').toUpperCase();
  return rates[code] || rates.rates?.[code] || DEFAULT_NGN_RATES[code] || DEFAULT_NGN_RATES.USDC;
}

/**
 * Convert an amount in USDC or XLM to NGN and format with commas.
 * Returns null if amount is invalid or <= 0.
 */
export function formatNaira(amount, rate = 1600) {
  const num = parseFloat(amount);
  if (!Number.isFinite(num) || num <= 0) return null;
  const numRate = parseFloat(rate) || DEFAULT_NGN_RATES.USDC;
  const total = num * numRate;
  if (total >= 100) {
    return Math.round(total).toLocaleString('en-US');
  }
  return total.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Format an amount as an approximate Naira string, clearly marked as approximate.
 * e.g. "≈ ₦1,600,000 approx."
 */
export function formatApproxNaira(amount, rate = 1600) {
  const formatted = formatNaira(amount, rate);
  if (!formatted) return null;
  return `≈ ₦${formatted} approx.`;
}
