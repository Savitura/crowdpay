const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const logger = require('../config/logger');
const impactReportService = require('../services/impactReportService');

const router = express.Router();

// Helper: async error handler
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Middleware: Campaign member verification
const requireCampaignMember = (...allowedRoles) => {
  return asyncHandler(async (req, res, next) => {
    const campaignId = req.params.campaignId;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required' });

    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRows[0];

    if (req.user.role === 'admin') {
      req.campaignRole = 'owner';
      return next();
    }

    const { rows: memberRows } = await db.query(
      'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [campaignId, req.user.userId]
    );

    let role = null;
    if (memberRows.length && memberRows[0].accepted_at) {
      role = memberRows[0].role;
    } else if (campaign.creator_id === req.user.userId) {
      role = 'owner';
    }

    if (!role || (allowedRoles.length && !allowedRoles.includes(role))) {
      return res.status(403).json({ error: 'Insufficient permissions for this campaign' });
    }

    req.campaignRole = role;
    next();
  });
};

/**
 * POST /api/campaigns/:campaignId/impact-report
 * Create a draft impact report (creator only)
 */
router.post(
  '/:campaignId/impact-report',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  [
    param('campaignId').isUUID().withMessage('Invalid campaign ID'),
    body('title')
      .trim()
      .notEmpty()
      .withMessage('Title is required')
      .isLength({ max: 255 })
      .withMessage('Title must be at most 255 characters'),
    body('content').trim().notEmpty().withMessage('Content is required'),
    body('summary')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Summary must be at most 500 characters'),
    body('images').optional().isArray().withMessage('Images must be an array'),
    body('videos').optional().isArray().withMessage('Videos must be an array'),
    body('milestones').optional().isArray().withMessage('Milestones must be an array'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { campaignId } = req.params;
    const { title, content, summary, images, videos, milestones } = req.body;
    const creatorId = req.user.userId;

    const reportId = await impactReportService.createImpactReport({
      campaignId,
      creatorId,
      title,
      content,
      summary,
      images,
      videos,
      milestones,
    });

    res.status(201).json({ id: reportId });
  })
);

/**
 * PUT /api/campaigns/:campaignId/impact-report
 * Update a draft impact report (creator only)
 */
router.put(
  '/:campaignId/impact-report',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  [
    param('campaignId').isUUID().withMessage('Invalid campaign ID'),
    body('title')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Title cannot be empty')
      .isLength({ max: 255 })
      .withMessage('Title must be at most 255 characters'),
    body('content').optional().trim().notEmpty().withMessage('Content cannot be empty'),
    body('summary')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Summary must be at most 500 characters'),
    body('images').optional().isArray().withMessage('Images must be an array'),
    body('videos').optional().isArray().withMessage('Videos must be an array'),
    body('milestones').optional().isArray().withMessage('Milestones must be an array'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { campaignId } = req.params;
    const creatorId = req.user.userId;
    const updates = req.body;

    // Get draft report to get its ID
    const draftReport = await impactReportService.getDraftImpactReport(campaignId, creatorId);
    if (!draftReport) {
      return res.status(404).json({ error: 'Draft impact report not found' });
    }

    await impactReportService.updateImpactReport(draftReport.id, creatorId, updates);

    res.json({ success: true });
  })
);

/**
 * POST /api/campaigns/:campaignId/impact-report/publish
 * Publish a draft report and notify contributors (creator only)
 */
router.post(
  '/:campaignId/impact-report/publish',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  [param('campaignId').isUUID().withMessage('Invalid campaign ID')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { campaignId } = req.params;
    const creatorId = req.user.userId;

    // Get draft report to get its ID
    const draftReport = await impactReportService.getDraftImpactReport(campaignId, creatorId);
    if (!draftReport) {
      return res.status(404).json({ error: 'Draft impact report not found' });
    }

    await impactReportService.publishImpactReport(draftReport.id, creatorId);

    res.json({ success: true, reportId: draftReport.id });
  })
);

/**
 * GET /api/campaigns/:campaignId/impact-report
 * Get published report for display (public)
 */
router.get(
  '/:campaignId/impact-report',
  [param('campaignId').isUUID().withMessage('Invalid campaign ID')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { campaignId } = req.params;

    const report = await impactReportService.getImpactReport(campaignId);

    if (!report) {
      return res.status(404).json({ error: 'Impact report not found' });
    }

    res.json(report);
  })
);

/**
 * GET /api/campaigns/:campaignId/impact-report/draft
 * Get draft report for editing (creator only)
 */
router.get(
  '/:campaignId/impact-report/draft',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  [param('campaignId').isUUID().withMessage('Invalid campaign ID')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { campaignId } = req.params;
    const creatorId = req.user.userId;

    const report = await impactReportService.getDraftImpactReport(campaignId, creatorId);

    if (!report) {
      return res.status(404).json({ error: 'Draft impact report not found' });
    }

    res.json(report);
  })
);

module.exports = router;
