const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const db = require('../config/database');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/outcomeSurveyService');

// Beneficiary outcome surveys after campaign completion (#960). Mounted at
// /api/campaigns next to the other campaign-scoped sub-resources.
//
// Access model:
//   - read            public (aggregate count only; answers never leave the owner view)
//   - respond         authenticated backer of THIS campaign
//   - create/edit/open/close  campaign owner, accepted manager, or admin
//   - results/events  campaign owner, accepted manager, or admin

const isTest = process.env.NODE_ENV === 'test';

const respondLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user?.userId || ipKeyGenerator(req.ip),
  message: { error: 'Too many survey submissions. Please try again in a minute.' },
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

  // The public read runs behind optionalAuth, so an anonymous viewer simply
  // has no role rather than an error.
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

/** Creator/accepted-manager/admin gate for every management endpoint. */
function requireCampaignManager(req, res, next) {
  if (!MANAGE_ROLES.has(req.campaignRole)) {
    return res.status(403).json({
      error: 'Only the campaign creator or an accepted manager can manage the outcome survey',
    });
  }
  next();
}

/**
 * @openapi
 * components:
 *   schemas:
 *     OutcomeSurveyQuestion:
 *       type: object
 *       required: [id, prompt, type, required]
 *       properties:
 *         id: { type: string, description: Stable id derived from the prompt }
 *         prompt: { type: string, maxLength: 500 }
 *         type: { type: string, enum: [rating, single_choice, text] }
 *         required: { type: boolean }
 *         options:
 *           type: array
 *           nullable: true
 *           items: { type: string, maxLength: 200 }
 *     OutcomeSurvey:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         campaign_id: { type: string, format: uuid }
 *         created_by: { type: string, format: uuid, nullable: true }
 *         title: { type: string, maxLength: 200 }
 *         intro: { type: string, nullable: true }
 *         questions:
 *           type: array
 *           items: { $ref: '#/components/schemas/OutcomeSurveyQuestion' }
 *         status: { type: string, enum: [draft, open, closed] }
 *         opens_at: { type: string, format: date-time, nullable: true }
 *         closes_at: { type: string, format: date-time, nullable: true }
 *         published_at: { type: string, format: date-time, nullable: true }
 *         closed_at: { type: string, format: date-time, nullable: true }
 *         created_at: { type: string, format: date-time }
 *         updated_at: { type: string, format: date-time }
 *     OutcomeSurveyDraft:
 *       type: object
 *       required: [title]
 *       properties:
 *         title: { type: string, maxLength: 200 }
 *         intro: { type: string, maxLength: 2000, nullable: true }
 *         questions:
 *           type: array
 *           maxItems: 10
 *           items: { $ref: '#/components/schemas/OutcomeSurveyQuestion' }
 */

/**
 * @openapi
 * /api/campaigns/{campaignId}/outcome-survey:
 *   get:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Read the campaign's outcome survey and aggregate response count
 *     description: >-
 *       Public. Returns `survey: null` when the campaign has no survey yet and
 *       the `draft` status for the creator's unpublished draft. An
 *       authenticated backer also receives their own `my_response`; nobody else
 *       can read individual answers through this endpoint.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: "Survey, response count, and the caller's own response"
 *       404: { description: Campaign not found }
 *   post:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Create the campaign's outcome survey as a draft
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
 *           schema: { $ref: '#/components/schemas/OutcomeSurveyDraft' }
 *     responses:
 *       201: { description: Draft created }
 *       401: { description: Authentication required }
 *       403: { description: "Creator, accepted manager, or admin only" }
 *       404: { description: Campaign not found }
 *       409: { description: "Campaign not finished funding, or a survey already exists" }
 *       422: { description: "Invalid title, intro, or question set" }
 *   put:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Edit the survey while it is still a draft
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
 *           schema: { $ref: '#/components/schemas/OutcomeSurveyDraft' }
 *     responses:
 *       200: { description: Draft updated }
 *       403: { description: "Creator, accepted manager, or admin only" }
 *       404: { description: Campaign or survey not found }
 *       409: { description: The survey is already open or closed }
 *       422: { description: "Invalid title, intro, or question set" }
 *
 * @openapi
 * /api/campaigns/{campaignId}/outcome-survey/open:
 *   post:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Publish the survey and invite eligible backers
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               closes_at: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200: { description: Survey opened with the number of backers invited }
 *       403: { description: "Creator, accepted manager, or admin only" }
 *       404: { description: Campaign or survey not found }
 *       409: { description: "Not a draft, or the survey has no questions" }
 *       422: { description: closes_at is in the past }
 *
 * @openapi
 * /api/campaigns/{campaignId}/outcome-survey/close:
 *   post:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Stop accepting responses
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Survey closed (idempotent) }
 *       403: { description: "Creator, accepted manager, or admin only" }
 *       404: { description: Campaign or survey not found }
 *       409: { description: The survey was never opened }
 *
 * @openapi
 * /api/campaigns/{campaignId}/outcome-survey/respond:
 *   post:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Submit this backer's answers
 *     description: >-
 *       One response per (survey, backer). A second submission is a 409, and
 *       answers are validated against the published question set so a stale
 *       client cannot submit ids that no longer exist.
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
 *             required: [answers]
 *             properties:
 *               answers:
 *                 type: object
 *                 additionalProperties: true
 *     responses:
 *       201: { description: Response recorded }
 *       400: { description: Malformed request }
 *       401: { description: Authentication required }
 *       403: { description: Not a contributor to this campaign }
 *       404: { description: Campaign or survey not found }
 *       409: { description: "Survey not open, already closed, or already answered" }
 *       422: { description: Answers failed validation }
 *       429: { description: Rate limit exceeded }
 *
 * @openapi
 * /api/campaigns/{campaignId}/outcome-survey/results:
 *   get:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Aggregated results for the campaign team
 *     description: >-
 *       Per-question aggregates only. Individual response rows are never
 *       returned, so a creator cannot deanonymise their backers.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Aggregated results }
 *       403: { description: "Creator, accepted manager, or admin only" }
 *       404: { description: Campaign or survey not found }
 *
 * @openapi
 * /api/campaigns/{campaignId}/outcome-survey/events:
 *   get:
 *     tags: [Campaigns — Outcome Surveys]
 *     summary: Lifecycle audit trail for the survey
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Ordered lifecycle events }
 *       403: { description: "Creator, accepted manager, or admin only" }
 *       404: { description: Campaign not found }
 */

/**
 * GET /api/campaigns/:campaignId/outcome-survey
 *
 * Public read. `survey: null` (200, not 404) means "this campaign has no
 * survey", which the UI renders as an empty state rather than an error.
 */
router.get(
  '/:campaignId/outcome-survey',
  optionalAuth,
  asyncHandler(loadCampaignContext),
  asyncHandler(async (req, res) => {
    const payload = await service.getPublicSurvey(req.params.campaignId, req.user?.userId || null);
    res.json(payload);
  })
);

/**
 * POST /api/campaigns/:campaignId/outcome-survey
 */
router.post(
  '/:campaignId/outcome-survey',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const existing = await service.getSurveyByCampaign(req.params.campaignId);
    if (existing) {
      return res.status(409).json({ error: 'An outcome survey already exists for this campaign' });
    }
    const survey = await service.createSurvey({
      campaignId: req.params.campaignId,
      creatorId: req.user.userId,
      ...(req.body || {}),
    });
    return res.status(201).json(survey);
  })
);

/**
 * PUT /api/campaigns/:campaignId/outcome-survey
 */
router.put(
  '/:campaignId/outcome-survey',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const survey = await service.updateSurvey({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
      ...(req.body || {}),
    });
    res.json(survey);
  })
);

/**
 * POST /api/campaigns/:campaignId/outcome-survey/open
 */
router.post(
  '/:campaignId/outcome-survey/open',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const { survey, invited } = await service.openSurvey({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
      closesAt: req.body?.closes_at ?? null,
    });
    res.json({ survey, invited });
  })
);

/**
 * POST /api/campaigns/:campaignId/outcome-survey/close
 */
router.post(
  '/:campaignId/outcome-survey/close',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    const { survey, already_closed: alreadyClosed } = await service.closeSurvey({
      campaignId: req.params.campaignId,
      actorId: req.user.userId,
    });
    res.json({ survey, already_closed: alreadyClosed });
  })
);

/**
 * POST /api/campaigns/:campaignId/outcome-survey/respond
 */
router.post(
  '/:campaignId/outcome-survey/respond',
  requireAuth,
  respondLimiter,
  asyncHandler(loadCampaignContext),
  asyncHandler(async (req, res) => {
    const response = await service.submitResponse({
      campaignId: req.params.campaignId,
      userId: req.user.userId,
      answers: req.body?.answers,
    });
    res.status(201).json(response);
  })
);

/**
 * GET /api/campaigns/:campaignId/outcome-survey/results
 */
router.get(
  '/:campaignId/outcome-survey/results',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    res.json(await service.getResults(req.params.campaignId));
  })
);

/**
 * GET /api/campaigns/:campaignId/outcome-survey/events
 */
router.get(
  '/:campaignId/outcome-survey/events',
  requireAuth,
  asyncHandler(loadCampaignContext),
  requireCampaignManager,
  asyncHandler(async (req, res) => {
    res.json({ events: await service.listEvents(req.params.campaignId) });
  })
);

module.exports = router;
