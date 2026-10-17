const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  createPayoutSchedule,
  listPayoutSchedules,
  getPayoutSchedule,
  pausePayoutSchedule,
  resumePayoutSchedule,
  cancelPayoutSchedule,
} = require('../services/payoutScheduleService');

async function requireCampaignOwner(req, res, next) {
  const campaignId = req.params.id;
  const { rows } = await db.query(
    'SELECT id, creator_id, asset_type, status FROM campaigns WHERE id = $1',
    [campaignId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const campaign = rows[0];
  if (campaign.creator_id !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the campaign creator can manage payout schedules' });
  }

  req.campaign = campaign;
  next();
}

/**
 * @openapi
 * /api/campaigns/{id}/payout-schedules:
 *   post:
 *     tags: [Withdrawals, PayoutSchedules]
 *     summary: Create a recurring payout schedule
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/:id/payout-schedules',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const {
      amount,
      percentage,
      asset_type,
      destination_key,
      cadence,
      start_date,
      end_date,
      max_occurrences,
      timezone,
    } = req.body;

    const schedule = await createPayoutSchedule({
      campaignId: req.params.id,
      creatorId: req.user.userId,
      amount,
      percentage,
      assetType: asset_type || req.campaign.asset_type,
      destinationKey: destination_key,
      cadence,
      startDate: start_date,
      endDate: end_date,
      maxOccurrences: max_occurrences,
      timezone: timezone || 'UTC',
    });

    res.status(201).json(schedule);
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/payout-schedules:
 *   get:
 *     tags: [Withdrawals, PayoutSchedules]
 *     summary: List recurring payout schedules for a campaign
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/:id/payout-schedules',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const schedules = await listPayoutSchedules(req.params.id, req.user.userId);
    res.json(schedules);
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/payout-schedules/{scheduleId}:
 *   get:
 *     tags: [Withdrawals, PayoutSchedules]
 *     summary: Get payout schedule details and run history
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/:id/payout-schedules/:scheduleId',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const schedule = await getPayoutSchedule(req.params.scheduleId, req.params.id, req.user.userId);
    res.json(schedule);
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/payout-schedules/{scheduleId}/pause:
 *   post:
 *     tags: [Withdrawals, PayoutSchedules]
 *     summary: Pause an active payout schedule
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/:id/payout-schedules/:scheduleId/pause',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const updated = await pausePayoutSchedule(
      req.params.scheduleId,
      req.params.id,
      req.user.userId
    );
    res.json(updated);
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/payout-schedules/{scheduleId}/resume:
 *   post:
 *     tags: [Withdrawals, PayoutSchedules]
 *     summary: Resume a paused payout schedule
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/:id/payout-schedules/:scheduleId/resume',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const updated = await resumePayoutSchedule(
      req.params.scheduleId,
      req.params.id,
      req.user.userId
    );
    res.json(updated);
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/payout-schedules/{scheduleId}:
 *   delete:
 *     tags: [Withdrawals, PayoutSchedules]
 *     summary: Cancel a payout schedule
 *     security:
 *       - bearerAuth: []
 */
router.delete(
  '/:id/payout-schedules/:scheduleId',
  requireAuth,
  requireCampaignOwner,
  asyncHandler(async (req, res) => {
    const cancelled = await cancelPayoutSchedule(
      req.params.scheduleId,
      req.params.id,
      req.user.userId
    );
    res.json(cancelled);
  })
);

module.exports = router;
