// backend/src/routes/campaigns/refunds.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { toStroops } = require('../../utils/stroops');

function createRefundsRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const logger = deps.logger || require('../../config/logger');
  const auth = deps.auth || require('../../middleware/auth');
  const stellarService = deps.stellarService || require('../../services/stellarService');
  const walletSecrets = deps.walletSecrets || require('../../services/walletSecrets');
  const campaignStatusActions =
    deps.campaignStatusActions || require('../../services/campaignStatusActions');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth, requireRole } = auth;
  const { queueFailedCampaignRefunds } = campaignStatusActions;
  const { requireCampaignMember } = helpers;

  let _refundService;
  function getRefundService() {
    if (!_refundService) _refundService = require('../../services/refundService');
    return _refundService;
  }

  router.post(
    '/:id/trigger-refunds',
    requireAuth,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;
      const { rows: campaigns } = await db.query(
        `SELECT id, wallet_public_key, status FROM campaigns WHERE id = $1`,
        [campaignId]
      );
      if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
      const campaign = campaigns[0];
      if (campaign.status !== 'failed') {
        return res
          .status(409)
          .json({ error: 'Refunds may only be triggered for failed campaigns' });
      }

      try {
        const { refundsCreated, refunds } = await queueFailedCampaignRefunds(
          campaignId,
          req.user.userId
        );
        if (refundsCreated === 0) {
          return res.json({ refundsCreated: 0 });
        }
        res.status(201).json({ refundsCreated, refunds });
      } catch (err) {
        logger.error('Refund trigger failed', { campaign_id: campaignId, error: err.message });
        res.status(500).json({ error: 'Could not trigger refunds for campaign' });
      }
    })
  );

  // Check if draft campaign is a duplicate

  router.get(
    '/:id/refunds/eligible',
    requireAuth,
    asyncHandler(async (req, res) => {
      const campaign = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
      const isOwner = campaign.rows[0].creator_id === req.user.userId;
      const isAdmin = req.user.role === 'admin';
      if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
      const items = await getRefundService().getEligibleContributions(req.params.id);
      res.json({ items });
    })
  );

  router.get(
    '/:id/refunds',
    requireAuth,
    asyncHandler(async (req, res) => {
      const campaign = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
      const isOwner = campaign.rows[0].creator_id === req.user.userId;
      const isAdmin = req.user.role === 'admin';
      if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
      const result = await getRefundService().getCampaignRefunds(req.params.id, req.query);
      res.json(result);
    })
  );

  router.post(
    '/:id/refunds',
    requireAuth,
    asyncHandler(async (req, res) => {
      const campaign = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
      const isOwner = campaign.rows[0].creator_id === req.user.userId;
      const isAdmin = req.user.role === 'admin';
      if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

      const { contributionId, amount, reason, isForceRefund, adminNote } = req.body;
      if (!contributionId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'contributionId and positive amount are required' });
      }

      const refund = await getRefundService().processRefund({
        campaignId: req.params.id,
        contributionId,
        amount: parseFloat(amount),
        reason,
        initiatorId: req.user.userId,
        isForceRefund: isAdmin && !!isForceRefund,
        adminNote: isAdmin ? adminNote : null,
      });
      res.status(201).json(refund);
    })
  );

  // ---------------------------------------------------------------------------
  // Campaign draft autosave + recoverable version history (#942)
  // ---------------------------------------------------------------------------

  function mapDraftError(err, res) {
    if (err.code === 'DRAFT_VERSION_CONFLICT') {
      return res
        .status(409)
        .json({ error: err.message, code: err.code, current_version: err.currentVersion });
    }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    throw err;
  }

  // Autosave editable draft fields with optimistic concurrency. `base_version`
  // (or a `draft_version` body field) is the version the editor started from; a
  // mismatch returns 409 and both versions stay recoverable.

  return router;
}

module.exports = createRefundsRouter;
module.exports.createRefundsRouter = createRefundsRouter;
