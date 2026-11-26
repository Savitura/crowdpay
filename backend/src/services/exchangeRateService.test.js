'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getExchangeRates,
  convertToNaira,
  DEFAULT_FALLBACK_RATES,
  _clearCache,
} = require('./exchangeRateService');

const originalFetch = global.fetch;
const originalDateNow = Date.now;

function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  return calls;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe('exchangeRateService', () => {
  beforeEach(() => {
    _clearCache();
    global.fetch = originalFetch;
    Date.now = originalDateNow;
  });

  afterEach(() => {
    _clearCache();
    global.fetch = originalFetch;
    Date.now = originalDateNow;
  });

  it('fetches live rates from CoinGecko and returns approximate: true', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        'usd-coin': { ngn: 1650 },
        stellar: { ngn: 210 },
      })
    );

    const result = await getExchangeRates('ngn');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/api\.coingecko\.com\//);
    assert.equal(result.base, 'USD');
    assert.equal(result.target, 'NGN');
    assert.equal(result.approximate, true);
    assert.equal(result.source, 'coingecko');
    assert.deepEqual(result.rates, {
      USDC: 1650,
      USD: 1650,
      XLM: 210,
    });
  });

  it('derives XLM rate from USDC when CoinGecko omits stellar.ngn', async () => {
    stubFetch(() =>
      jsonResponse({
        'usd-coin': { ngn: 1555 },
        stellar: {},
      })
    );

    const result = await getExchangeRates('NGN');
    assert.equal(result.source, 'coingecko');
    assert.equal(result.rates.USDC, 1555);
    assert.equal(result.rates.XLM, 155.5);
  });

  it('falls back to open.er-api.com when CoinGecko fails or returns invalid data', async () => {
    const calls = stubFetch(url => {
      if (url.includes('coingecko.com')) {
        return jsonResponse({}, { ok: false, status: 429 });
      }
      if (url.includes('open.er-api.com')) {
        return jsonResponse({
          rates: { NGN: 1620, XLM: 8 },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await getExchangeRates('NGN');
    assert.equal(calls.length, 2);
    assert.equal(result.source, 'open.er-api.com');
    assert.deepEqual(result.rates, {
      USDC: 1620,
      USD: 1620,
      XLM: 202.5,
    });
  });

  it('derives XLM rate at 10% of NGN when open.er-api.com omits XLM', async () => {
    stubFetch(url => {
      if (url.includes('coingecko.com')) {
        throw new Error('CoinGecko network timeout');
      }
      return jsonResponse({
        rates: { NGN: 1500 },
      });
    });

    const result = await getExchangeRates('NGN');
    assert.equal(result.source, 'open.er-api.com');
    assert.deepEqual(result.rates, {
      USDC: 1500,
      USD: 1500,
      XLM: 150,
    });
  });

  it('falls back to DEFAULT_FALLBACK_RATES when all upstream providers fail', async () => {
    const calls = stubFetch(() => {
      throw new Error('Network unreachable');
    });

    const result = await getExchangeRates('NGN');
    assert.equal(calls.length, 2);
    assert.equal(result.source, 'fallback');
    assert.equal(result.approximate, true);
    assert.deepEqual(result.rates, DEFAULT_FALLBACK_RATES);
  });

  it('falls back to DEFAULT_FALLBACK_RATES when upstream providers return non-positive or NaN rates', async () => {
    stubFetch(url => {
      if (url.includes('coingecko.com')) {
        return jsonResponse({ 'usd-coin': { ngn: 0 } });
      }
      return jsonResponse({ rates: { NGN: -5 } });
    });

    const result = await getExchangeRates('NGN');
    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.rates, DEFAULT_FALLBACK_RATES);
  });

  it('caches rates within the 10-minute TTL and re-fetches after TTL expiration', async () => {
    let now = 1_700_000_000_000;
    Date.now = () => now;

    let fetchCount = 0;
    stubFetch(() => {
      fetchCount += 1;
      return jsonResponse({
        'usd-coin': { ngn: fetchCount === 1 ? 1600 : 1700 },
        stellar: { ngn: fetchCount === 1 ? 160 : 170 },
      });
    });

    const first = await getExchangeRates('NGN');
    assert.equal(first.rates.USDC, 1600);
    assert.equal(first.cached, undefined);
    assert.equal(fetchCount, 1);

    // Within 10-minute TTL (9m 59s later)
    now += 9 * 60 * 1000 + 59 * 1000;
    const second = await getExchangeRates('NGN');
    assert.equal(second.cached, true);
    assert.equal(second.rates.USDC, 1600);
    assert.equal(fetchCount, 1);

    // Past 10-minute TTL
    now += 2000;
    const third = await getExchangeRates('NGN');
    assert.equal(third.cached, undefined);
    assert.equal(third.rates.USDC, 1700);
    assert.equal(fetchCount, 2);
  });

  it('convertToNaira converts USDC, XLM, numeric strings, and falls back to USDC for unknown assets', async () => {
    stubFetch(() =>
      jsonResponse({
        'usd-coin': { ngn: 1600 },
        stellar: { ngn: 165.5 },
      })
    );

    const usdc = await convertToNaira(10, 'USDC');
    assert.deepEqual(usdc, {
      amount: 16000,
      original_amount: 10,
      asset: 'USDC',
      target: 'NGN',
      rate: 1600,
      approximate: true,
    });

    const xlm = await convertToNaira('2.5', 'xlm');
    assert.deepEqual(xlm, {
      amount: 413.75,
      original_amount: 2.5,
      asset: 'XLM',
      target: 'NGN',
      rate: 165.5,
      approximate: true,
    });

    const unknown = await convertToNaira(1, 'EUR');
    assert.equal(unknown.asset, 'EUR');
    assert.equal(unknown.rate, 1600);
    assert.equal(unknown.amount, 1600);
  });

  it('convertToNaira rejects invalid amounts', async () => {
    await assert.rejects(() => convertToNaira('invalid-number', 'USDC'), /Invalid amount/);
    await assert.rejects(() => convertToNaira(NaN, 'USDC'), /Invalid amount/);
    await assert.rejects(() => convertToNaira(Infinity, 'USDC'), /Invalid amount/);
  });
});
