'use strict';

const logger = require('../config/logger');
const { TtlCache } = require('../utils/TtlCache');

// Default fallback rates if external providers are unavailable or in offline testing.
const DEFAULT_FALLBACK_RATES = {
  USDC: parseFloat(process.env.DEFAULT_USDC_NGN_RATE || '1600'),
  USD: parseFloat(process.env.DEFAULT_USD_NGN_RATE || '1600'),
  XLM: parseFloat(process.env.DEFAULT_XLM_NGN_RATE || '160'),
};

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes cache TTL
const cache = new TtlCache(DEFAULT_TTL_MS);

/**
 * Fetch live exchange rates targeting NGN from free public sources.
 */
async function fetchLiveRates() {
  // Source 1: CoinGecko simple price (provides both USDC and Stellar XLM in NGN)
  try {
    const cgUrl =
      'https://api.coingecko.com/api/v3/simple/price?ids=stellar,usd-coin&vs_currencies=ngn,usd';
    const res = await fetch(cgUrl, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      const usdcNgn = parseFloat(body?.['usd-coin']?.ngn);
      const xlmNgn = parseFloat(body?.stellar?.ngn);
      if (Number.isFinite(usdcNgn) && usdcNgn > 0) {
        return {
          rates: {
            USDC: usdcNgn,
            USD: usdcNgn,
            XLM:
              Number.isFinite(xlmNgn) && xlmNgn > 0
                ? xlmNgn
                : Math.round(usdcNgn * 0.1 * 100) / 100,
          },
          source: 'coingecko',
        };
      }
    }
  } catch (err) {
    logger.warn('Failed to fetch rates from CoinGecko, attempting open.er-api.com', {
      error: err.message,
    });
  }

  // Source 2: open.er-api.com (provides USD/NGN and USD/XLM)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      const ngnRate = parseFloat(body?.rates?.NGN);
      if (Number.isFinite(ngnRate) && ngnRate > 0) {
        const xlmUsd = parseFloat(body?.rates?.XLM);
        const xlmRate = Number.isFinite(xlmUsd) && xlmUsd > 0 ? ngnRate / xlmUsd : ngnRate * 0.1;
        return {
          rates: {
            USDC: ngnRate,
            USD: ngnRate,
            XLM: Math.round(xlmRate * 100) / 100,
          },
          source: 'open.er-api.com',
        };
      }
    }
  } catch (err) {
    logger.warn('Failed to fetch from open.er-api.com', { error: err.message });
  }

  return {
    rates: { ...DEFAULT_FALLBACK_RATES },
    source: 'fallback',
  };
}

/**
 * Get exchange rates against NGN, using the cached rates when valid.
 *
 * @param {string} target Target currency code (defaults to 'NGN')
 * @returns {Promise<{target: string, rates: {USDC: number, USD: number, XLM: number}, approximate: boolean, source: string, timestamp: number}>}
 */
async function getExchangeRates(target = 'NGN') {
  const normTarget = String(target || 'NGN').toUpperCase();
  const cacheKey = `rates:${normTarget}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
    };
  }

  // Use wrap to avoid thundering herd
  return cache.wrap(cacheKey, async () => {
    try {
      const { rates, source } = await fetchLiveRates();
      return {
        base: 'USD',
        target: normTarget,
        rates,
        approximate: true,
        source,
        timestamp: Date.now(),
      };
    } catch (err) {
      logger.warn('Error obtaining exchange rates, returning defaults', { error: err.message });
      return {
        base: 'USD',
        target: normTarget,
        rates: { ...DEFAULT_FALLBACK_RATES },
        approximate: true,
        source: 'fallback',
        timestamp: Date.now(),
      };
    }
  });
}

/**
 * Convert an amount in a given asset into NGN.
 *
 * @param {number|string} amount
 * @param {string} asset
 * @returns {Promise<{ amount: number, original_amount: number, asset: string, target: string, rate: number, approximate: boolean }>}
 */
async function convertToNaira(amount, asset = 'USDC') {
  const numAmount = parseFloat(amount);
  if (!Number.isFinite(numAmount)) {
    throw new Error('Invalid amount');
  }

  const { rates } = await getExchangeRates('NGN');
  const normAsset = String(asset || 'USDC').toUpperCase();
  const rate = rates[normAsset] || rates.USDC || DEFAULT_FALLBACK_RATES.USDC;
  const converted = Math.round(numAmount * rate * 100) / 100;

  return {
    amount: converted,
    original_amount: numAmount,
    asset: normAsset,
    target: 'NGN',
    rate,
    approximate: true,
  };
}

function _clearCache() {
  cache.clear();
}

module.exports = {
  getExchangeRates,
  convertToNaira,
  DEFAULT_FALLBACK_RATES,
  _clearCache,
};
