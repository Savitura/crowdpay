import { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  DEFAULT_NGN_RATES,
  getRateForAsset,
  formatNaira,
  formatApproxNaira,
} from '../utils/currency';

let cachedRates = DEFAULT_NGN_RATES;
let lastFetchTime = 0;
let inFlightPromise = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory cache

async function fetchRates() {
  const now = Date.now();
  if (now - lastFetchTime < CACHE_TTL_MS && cachedRates) {
    return cachedRates;
  }
  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = (async () => {
    try {
      if (typeof api?.getExchangeRates === 'function') {
        const res = await api.getExchangeRates('NGN');
        if (res?.rates) {
          cachedRates = res.rates;
          lastFetchTime = Date.now();
          return cachedRates;
        }
      }
    } catch {
      // Fallback on network error or missing mock in unit tests
    } finally {
      inFlightPromise = null;
    }
    return cachedRates || DEFAULT_NGN_RATES;
  })();

  return inFlightPromise;
}

/**
 * Hook to retrieve live cached NGN exchange rates.
 *
 * @param {string} [assetType='USDC']
 * @returns {{
 *   rate: number,
 *   rates: object,
 *   approximate: boolean,
 *   loading: boolean,
 *   formatNaira: (amount: number|string) => string|null,
 *   formatApproxNaira: (amount: number|string) => string|null
 * }}
 */
export function useExchangeRate(assetType = 'USDC') {
  const [rates, setRates] = useState(cachedRates);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    if (now - lastFetchTime >= CACHE_TTL_MS) {
      setLoading(true);
      fetchRates()
        .then((data) => {
          if (!cancelled && data) {
            setRates(data);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      setRates(cachedRates);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const rate = getRateForAsset(rates, assetType);

  return {
    rate,
    rates,
    approximate: true,
    loading,
    formatNaira: (amt) => formatNaira(amt, rate),
    formatApproxNaira: (amt) => formatApproxNaira(amt, rate),
  };
}
