const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const db = require('../config/database');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/disasterReliefService');

// Disaster-relief campaign mode with rapid verification workflow. Mounted at
// /api/campaigns alongside other campaign-scoped sub-resources.
//
// Access model:
//   - GET /:campaignId/disaster-relief          public (verified/revoked only; emergency_contact & review notes stripped)
//                                               managers/admins receive the full record including draft/pending/changes_requested/rejected
//   - POST /:campaignId/disaster-relief         campaign owner, accepted manager, or admin
//   - PUT /:campaignId/disaster-relief          campaign owner, accepted manager, or admin
//   - POST /:campaignId/disaster-relief/submit  campaign owner, accepted manager, or admin (rate-limited)
//   - POST /:campaignId/disaster-relief/review  admin only
//   - POST /:campaignId/disaster-relief/revoke  admin only
//   - GET /:campaignId/disaster-relief/events   campaign owner, accepted manager, or admin
//   - GET /disaster-relief/queue                admin only

const isTest = process.env.NODE_ENV === 'test';

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user?.userId || ipKeyGenerator(req.ip),
  message: { error: 'Too many rapid verification submissions. Please try again in a minute.' },
  skip: () => isTest,
});

const MANAGE_ROLES = new Set(['owner', 'manager']);

/**
 * Loads the campaign (404 for unknown/soft-deleted) and resolves the caller's
 * campaign role. `req.campaign` / `req.campaignRole` are consumed by
 * `requireCampaignManager`.
 */
async function loadCampaignContext(req, res, next) {
  const { rows } = await db.query(
    `SELECT c.id, c.creator_id, c.title, c.status
     FROM campaigns c
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [req.params.campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

  const campaign = rows[0];
  req.campaign = campaign;

  if (!req.user?.userId) {
    req.campaignRole = null;
    return next();
  }
  if (req.user.role === 'admin' || campaign.creator_id === req.user.userId) {
    req.campaignRole = 'owner';
    return next();
  }

  const { rows: memberRows } = await db.query(
    `SELECT role, accepted_at
     FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2`,
    [campaign.id, req.user.userId]
  );
  const membership = memberRows[0];
  req.campaignRole = membership && membership.accepted_at ? membership.role : null;
  return next();
}

function requireCampaignManager(req, res, next) {
  if (!MANAGE_ROLES.has(req.campaignRole)) {
    return res.status(403).json({
      error:
        'Only the campaign creator or an accepted manager can manage disaster-relief verification',
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: 'Only platform administrators can perform rapid verification reviews',
    });
  }
  next();
}

/**
 * @openapi
 * components:
 *   schemas:
 *     DisasterReliefEvidenceItem:
 *       type: object
 *       required: [title, type, url]
 *       properties:
 *         id: { type: string, description: Stable evidence identifier }
 *         title: { type: string, maxLength: 140 }
 *         type:
 *           type: string
 *           enum: [government_notice, media_report, ngo_registration, field_assessment, logistics_plan, other]
 *         url: { type: string, format: uri, description: HTTPS URL to verifiable evidence }
 *         issuer: { type: string, maxLength: 140, nullable: true }
 *     DisasterReliefDossier:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         campaign_id: { type: string, format: uuid }
 *         incident_name: { type: string, maxLength: 160 }
 *         disaster_type:
 *           type: string
 *           enum: [flood, earthquake, wildfire, hurricane, drought, conflict, epidemic, industrial, other]
 *         severity_level:
 *           type: string
 *           enum: [watch, urgent, critical, catastrophic]
 *         affected_region: { type: string, maxLength: 200 }
 *         affected_population: { type: integer, minimum: 1, nullable: true }
 *         responder_organization: { type: string, maxLength: 200, nullable: true }
 *         emergency_contact: { type: string, maxLength: 200, nullable: true }
 *         verification_badge: { type: string, maxLength: 120, nullable: true }
 *         evidence_items:
 *           type: array
 *           items: { $ref: '#/components/schemas/DisasterReliefEvidenceItem' }
 *         status:
 *           type: string
 *           enum: [draft, pending_review, verified, changes_requested, rejected, revoked]
 *         rapid_disbursement_enabled: { type: boolean }
 *         submitted_at: { type: string, format: date-time, nullable: true }
 *         reviewed_at: { type: string, format: date-time, nullable: true }
 *         revoked_at: { type: string, format: date-time, nullable: true }
 *         sla:
 *           type: object
 *           nullable: true
 *           properties:
 *             target_hours: { type: integer }
 *             due_at: { type: string, format: date-time }
 *             remaining_ms: { type: integer }
 *             is_overdue: { type: boolean }
 *     DisasterReliefUpsertInput:
 *       type: object
 *       required: [incident_name, disaster_type, severity_level, affected_region]
 *       properties:
 *         incident_name: { type: string, maxLength: 160 }
 *         disaster_type:
 *           type: string
 *           enum: [flood, earthquake, wildfire, hurricane, drought, conflict, epidemic, industrial, other]
 *         severity_level:
 *           type: string
 *           enum: [watch, urgent, critical, catastrophic]
 *         affected_region: { type: string, maxLength: 200 }
 *         affected_population: { type: integer, minimum: 1, nullable: true }
 *         responder_organization: { type: string, maxLength: 200, nullable: true }
 *         emergency_contact: { type: string, maxLength: 200, nullable: true }
 *         evidence_items:
 *           type: array
 *           maxItems: 10
 *           items: { $ref: '#/components/schemas/DisasterReliefEvidenceItem' }
 */

/**
 * @openapi
 * /api/campaigns/disaster-relief/queue:
 *   get:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: List campaigns in the rapid verification queue (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [draft, pending_review, verified, changes_requested, rejected, revoked]
 *     responses:
 *       200: { description: Prioritized rapid verification queue with SLA metrics }
 *       401: { description: Authentication required }
 *       403: { description: Admin role required }
 *       422: { description: Invalid status filter }
 *
 * @openapi
 * /api/campaigns/{campaignId}/disaster-relief:
 *   get:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Read the campaign's disaster-relief dossier and verification status
 *     description: >-
 *       Public callers receive the verified or revoked dossier with internal
 *       contact and reviewer notes redacted, or `disaster_relief: null` when
 *       the dossier is not yet verified. Campaign managers and admins receive
 *       the full dossier across all lifecycle states.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Disaster-relief dossier view }
 *       404: { description: Campaign not found }
 *   post:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Enable disaster-relief mode by creating a draft dossier
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/DisasterReliefUpsertInput' }
 *     responses:
 *       201: { description: Disaster-relief dossier created in draft status }
 *       401: { description: Authentication required }
 *       403: { description: Creator, accepted manager, or admin only }
 *       404: { description: Campaign not found }
 *       409: { description: Dossier already exists or campaign cannot enter disaster-relief mode }
 *       422: { description: Validation failed }
 *   put:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Update the disaster-relief dossier while in draft or changes_requested status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/DisasterReliefUpsertInput' }
 *     responses:
 *       200: { description: Disaster-relief dossier updated }
 *       403: { description: Creator, accepted manager, or admin only }
 *       404: { description: Campaign or dossier not found }
 *       409: { description: Dossier is locked for review or already finalized }
 *       422: { description: Validation failed }
 *
 * @openapi
 * /api/campaigns/{campaignId}/disaster-relief/submit:
 *   post:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Submit the disaster-relief dossier for rapid verification
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Dossier queued for rapid verification }
 *       403: { description: Creator, accepted manager, or admin only }
 *       404: { description: Campaign or dossier not found }
 *       409: { description: Dossier is not in draft or changes_requested status }
 *       422: { description: Missing required evidence items or emergency contact }
 *       429: { description: Rate limit exceeded }
 *
 * @openapi
 * /api/campaigns/{campaignId}/disaster-relief/review:
 *   post:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Record an admin rapid verification decision
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [decision]
 *             properties:
 *               decision:
 *                 type: string
 *                 enum: [verified, changes_requested, rejected]
 *               note: { type: string, maxLength: 1000, nullable: true }
 *               verification_badge: { type: string, maxLength: 120, nullable: true }
 *               rapid_disbursement_enabled: { type: boolean }
 *     responses:
 *       200: { description: Review decision recorded }
 *       403: { description: Admin role required }
 *       404: { description: Campaign or dossier not found }
 *       409: { description: Dossier is not awaiting rapid verification }
 *       422: { description: Invalid decision or missing required reviewer note }
 *
 * @openapi
 * /api/campaigns/{campaignId}/disaster-relief/revoke:
 *   post:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Revoke a previously verified disaster-relief status (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, maxLength: 1000 }
 *     responses:
 *       200: { description: Verified status revoked }
 *       403: { description: Admin role required }
 *       404: { description: Campaign or dossier not found }
 *       409: { description: Dossier is not currently verified }
 *       422: { description: Missing revocation reason }
 *
 * @openapi
 * /api/campaigns/{campaignId}/disaster-relief/events:
 *   get:
 *     tags: [Campaigns — Disaster Relief]
 *     summary: Lifecycle audit trail for the campaign's disaster-relief dossier
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Ordered lifecycle events }
 *       403: { description: Creator, accepted manager, or admin only }
 *       404: { description: Campaign not found }
 */

/**
 * GET /api/campaigns/disaster-relief/queue
 */
router.get(
  '/disaster-relief/queue',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const queue = await service.listRapidVerificationQueue({
      status: req.query.status || 'pending_review',
    });
    res.json({ queue });
  })
);

/**
 * GET /api/campaigns/:campaignId/disaster-relief
 */
router.get(
  '/:campaignId/disaster-relief',
  optionalAuth,
  asyncHandler(loadCampaignContext),
  asyncHandler(async (req, res) => {
    const isManager = MANAGE_ROLES.has(req.campaignRole);
    const payload = await service.getDisasterReliefView(req.params.campaignId, { isManager });
    res.json(payload);
  })
);

/**
 * POST /api/campaigns/:campaignId/disaster-relief
 */
router.post(
  '/:campaignId/disaster-relief',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const existing = await service.getDisasterReliefByCampaign(req.params.campaignId);
    if (existing) {
      return res.status(409).json({
        error: 'A disaster-relief dossier already exists for this campaign',
      });
    }
    const dossier = await service.createDisasterReliefDossier({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
      req,
      ...(req.body || {}),
    });
    return res.status(201).json({ disaster_relief: dossier });
  })
);

/**
 * PUT /api/campaigns/:campaignId/disaster-relief
 */
router.put(
  '/:campaignId/disaster-relief',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const dossier = await service.updateDisasterReliefDossier({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
      req,
      ...(req.body || {}),
    });
    res.json({ disaster_relief: dossier });
  })
);

/**
 * POST /api/campaigns/:campaignId/disaster-relief/submit
 */
router.post(
  '/:campaignId/disaster-relief/submit',
  requireAuth,
  submitLimiter,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const dossier = await service.submitForRapidVerification({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
      req,
    });
    res.json({ disaster_relief: dossier });
  })
);

/**
 * POST /api/campaigns/:campaignId/disaster-relief/review
 */
router.post(
  '/:campaignId/disaster-relief/review',
  requireAuth,
  requireAdmin,
  asyncHandler(loadCampaignContext),
  asyncHandler(async (req, res) => {
    const dossier = await service.reviewDisasterReliefDossier({
      campaignId: req.params.campaignId,
      reviewerId: req.user.userId,
      decision: req.body?.decision,
      note: req.body?.note,
      verificationBadge: req.body?.verification_badge,
      rapidDisbursementEnabled: req.body?.rapid_disbursement_enabled,
      req,
    });
    res.json({ disaster_relief: dossier });
  })
);

/**
 * POST /api/campaigns/:campaignId/disaster-relief/revoke
 */
router.post(
  '/:campaignId/disaster-relief/revoke',
  requireAuth,
  requireAdmin,
  asyncHandler(loadCampaignContext),
  asyncHandler(async (req, res) => {
    const dossier = await service.revokeDisasterReliefVerification({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
      reason: req.body?.reason,
      req,
    });
    res.json({ disaster_relief: dossier });
  })
);

/**
 * GET /api/campaigns/:campaignId/disaster-relief/events
 */
router.get(
  '/:campaignId/disaster-relief/events',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const events = await service.listEvents(req.params.campaignId);
    res.json({ events });
  })
);

module.exports = router;
