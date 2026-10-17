'use strict';

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  getPayoutForecast,
  getReserveBreakdown,
} = require('../services/payoutForecastService');
const {
  requireCampaignCreatorOrMember,
} = require('./creatorAnalytics');

const MIN_HORIZON = 1;
const MAX_HORIZON = 24;
const DEFAULT_HORIZON = 6;

function parseHorizon(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_HORIZON;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < MIN_HORIZON || n > MAX_HORIZON) return null;
  return n;
}

router.get(
  '/campaigns/:campaignId/payout-forecast',
  requireAuth,
  requireCampaignCreatorOrMember,
  asyncHandler(async (req, res) => {
    const horizon = parseHorizon(req.query.horizon);
    if (horizon === null) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `horizon must be an integer between ${MIN_HORIZON} and ${MAX_HORIZON}`,
          fields: [{ field: 'horizon', message: 'out of range' }],
        },
      });
    }

    const forecast = await getPayoutForecast(req.params.campaignId, {
      horizonMonths: horizon,
    });
    if (!forecast) return res.status(404).json({ error: 'Campaign not found' });
    res.json(forecast);
  })
);

router.get(
  '/campaigns/:campaignId/reserve',
  requireAuth,
  requireCampaignCreatorOrMember,
  asyncHandler(async (req, res) => {
    const breakdown = await getReserveBreakdown(req.params.campaignId);
    if (!breakdown) return res.status(404).json({ error: 'Campaign not found' });
    res.json(breakdown);
  })
);

module.exports = router;
