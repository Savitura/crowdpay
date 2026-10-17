'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { getExchangeRates, convertToNaira } = require('../services/exchangeRateService');

/**
 * GET /api/rates
 * Returns approximate exchange rates (defaults to target=NGN).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const target = req.query.target || 'NGN';
    const ratesData = await getExchangeRates(target);
    return res.json(ratesData);
  })
);

/**
 * GET /api/rates/ngn
 * Returns approximate NGN exchange rates.
 */
router.get(
  '/ngn',
  asyncHandler(async (_req, res) => {
    const ratesData = await getExchangeRates('NGN');
    return res.json(ratesData);
  })
);

/**
 * GET /api/rates/estimate
 * Convert an amount in USDC or XLM to approximate NGN.
 */
router.get(
  '/estimate',
  asyncHandler(async (req, res) => {
    const { amount, asset = 'USDC' } = req.query;
    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'Valid numeric amount is required' });
    }

    const conversion = await convertToNaira(amount, asset);
    return res.json(conversion);
  })
);

module.exports = router;
