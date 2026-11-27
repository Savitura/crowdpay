// backend/src/routes/campaigns/tiers.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const withTransaction = require('../../utils/withTransaction');

function createTiersRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const logger = deps.logger || require('../../config/logger');
  const auth = deps.auth || require('../../middleware/auth');
  const rewardTierService = deps.rewardTierService || require('../../services/rewardTierService');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth } = auth;
  const { requireCampaignMember } = helpers;
  const {
    MAX_TIERS_PER_CAMPAIGN,
    validateTiersInput,
    insertTiers,
    listTiersWithAvailability,
    getFulfillmentsByCampaign,
    getFulfillmentsByUser,
    updateFulfillmentStatus,
    getCampaignFulfillmentSummary,
  } = rewardTierService;

  router.get(
    '/:id/tiers',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
      const tiers = await listTiersWithAvailability(req.params.id);
      res.json(tiers);
    })
  );

  /**
   * @openapi
   * /api/campaigns/{id}/tiers:
   *   post:
   *     tags: [Campaigns]
   *     summary: Add one or more reward tiers to an existing campaign (creator only)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       201: { description: Updated list of reward tiers }
   *       400: { description: Invalid input or tier cap exceeded }
   *       403: { description: Forbidden }
   *       404: { description: Campaign not found }
   */

  router.post(
    '/:id/tiers',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;

      const { rows: campaignRows } = await db.query(
        'SELECT asset_type FROM campaigns WHERE id = $1',
        [campaignId]
      );
      if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
      const assetType = campaignRows[0].asset_type;

      // Accept either a single tier object or an array of tiers.
      const input = Array.isArray(req.body) ? req.body : [req.body];
      let normalizedTiers;
      try {
        normalizedTiers = validateTiersInput(input, assetType);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!normalizedTiers.length) {
        return res.status(400).json({ error: 'At least one reward tier is required' });
      }

      const { rows: countRows } = await db.query(
        'SELECT COUNT(*)::int AS n FROM reward_tiers WHERE campaign_id = $1',
        [campaignId]
      );
      if (countRows[0].n + normalizedTiers.length > MAX_TIERS_PER_CAMPAIGN) {
        return res.status(400).json({
          error: `A campaign can have at most ${MAX_TIERS_PER_CAMPAIGN} reward tiers`,
        });
      }

      try {
        await withTransaction(client => insertTiers(client, campaignId, normalizedTiers), db);
      } catch (err) {
        logger.error('[campaigns] add reward tiers failed', { error: err.message });
        return res.status(500).json({ error: 'Could not add reward tiers' });
      }

      const tiers = await listTiersWithAvailability(campaignId);
      res.status(201).json(tiers);
    })
  );

  // PATCH /campaigns/:id - Update campaign (title, description, deadline, country, target_amount, min/max contribution, max_per_user)

  router.get(
    '/:id/fulfillments',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const items = await getFulfillmentsByCampaign(req.params.id, { status: req.query.status });
      const summary = await getCampaignFulfillmentSummary(req.params.id);
      res.json({ data: items, summary });
    })
  );

  router.patch(
    '/:id/fulfillments/:fulfillmentId',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const { status, tracking_number, carrier, notes } = req.body || {};
      if (!status) return res.status(422).json({ error: 'status is required' });
      try {
        const updated = await updateFulfillmentStatus(req.params.fulfillmentId, status, {
          trackingNumber: tracking_number,
          carrier,
          notes,
        });
        res.json(updated);
      } catch (err) {
        res.status(err.statusCode || 400).json({ error: err.message });
      }
    })
  );

  router.get(
    '/:id/fulfillments/export.csv',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const items = await getFulfillmentsByCampaign(req.params.id, { status: req.query.status });
      const headers = [
        'id',
        'tier_title',
        'status',
        'shipping_name',
        'shipping_address_line1',
        'shipping_address_line2',
        'shipping_city',
        'shipping_region',
        'shipping_postal_code',
        'shipping_country',
        'tracking_number',
        'carrier',
        'created_at',
      ];
      const escape = v =>
        v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
      const csv = [
        headers.join(','),
        ...items.map(r => headers.map(h => escape(r[h])).join(',')),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="fulfillments-${req.params.id}.csv"`
      );
      res.send(csv);
    })
  );

  return router;
}

module.exports = createTiersRouter;
module.exports.createTiersRouter = createTiersRouter;
