'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getExchangeRates, convertToNaira, _clearCache } = require('./exchangeRateService');

describe('exchangeRateService', () => {
  beforeEach(() => {
    _clearCache();
  });

  it('returns valid rates structure with approximate: true', async () => {
    const result = await getExchangeRates('NGN');
    assert.equal(result.target, 'NGN');
    assert.equal(result.approximate, true);
    assert.ok(typeof result.rates.USDC === 'number');
    assert.ok(result.rates.USDC > 0);
    assert.ok(typeof result.rates.XLM === 'number');
    assert.ok(result.rates.XLM > 0);
  });

  it('caches the rate result on subsequent calls', async () => {
    const first = await getExchangeRates('NGN');
    assert.ok(first);

    const second = await getExchangeRates('NGN');
    assert.equal(second.cached, true);
    assert.equal(second.rates.USDC, first.rates.USDC);
  });

  it('convertToNaira converts amounts using the current rate', async () => {
    const res = await convertToNaira(10, 'USDC');
    assert.equal(res.original_amount, 10);
    assert.equal(res.asset, 'USDC');
    assert.equal(res.target, 'NGN');
    assert.equal(res.approximate, true);
    assert.equal(res.amount, Math.round(10 * res.rate * 100) / 100);
  });

  it('convertToNaira rejects invalid amount', async () => {
    await assert.rejects(async () => {
      await convertToNaira('invalid-number', 'USDC');
    }, /Invalid amount/);
  });
});
