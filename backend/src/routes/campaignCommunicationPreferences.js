const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  CHANNELS,
  CHANNEL_DESCRIPTIONS,
  setPreferences,
  getPreferences,
  resetPreferences,
  pickChannels,
  auditPreferenceChange,
} = require('../services/communicationPreferenceService');

// Per-campaign contributor communication preferences (#961). Mounted at
// /api/campaigns next to the other campaign-scoped sub-resources so the
// preference surface sits with its parent aggregate.

const isTest = process.env.NODE_ENV === 'test';

// Flipping a toggle is cheap, but a client stuck in a render loop would
// otherwise write a row and an audit event on every render.
const preferenceWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user?.userId || ipKeyGenerator(req.ip),
  message: { error: 'Too many preference changes. Please try again in a minute.' },
  skip: () => isTest,
});

/**
 * 404s for a missing or soft-deleted campaign before any preference work, so
 * this endpoint cannot be used to probe which campaign ids exist.
 */
async function loadCampaign(req, res, next) {
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL', [
    req.params.campaignId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  next();
}

/**
 * @openapi
 * components:
 *   schemas:
 *     CampaignCommunicationPreferences:
 *       type: object
 *       description: >-
 *         Per-campaign communication overrides for the authenticated
 *         contributor. Every channel defaults to true; an absent row means the
 *         contributor has never overridden anything for this campaign.
 *       properties:
 *         campaign_id: { type: string, format: uuid, nullable: true }
 *         updates: { type: boolean, description: Campaign updates and progress notes }
 *         milestones: { type: boolean, description: Milestone progress and releases }
 *         funding_updates: { type: boolean, description: Funding progress milestones }
 *         messages: { type: boolean, description: Comment replies and thank-you messages }
 *         surveys: { type: boolean, description: Outcome surveys and research }
 *     CampaignCommunicationPreferencePatch:
 *       type: object
 *       description: >-
 *         Partial patch — only the channels present in the body are written.
 *         Unknown keys and non-boolean values are ignored.
 *       properties:
 *         updates: { type: boolean }
 *         milestones: { type: boolean }
 *         funding_updates: { type: boolean }
 *         messages: { type: boolean }
 *         surveys: { type: boolean }
 *       additionalProperties: false
 *       example: { updates: true, milestones: false, surveys: true }
 */

/**
 * @openapi
 * /api/campaigns/{campaignId}/communication-preferences:
 *   get:
 *     tags: [Campaigns — Communication Preferences]
 *     summary: Read the authenticated contributor's per-campaign preferences
 *     description: >-
 *       Resolves to the defaults when the contributor has no override row for
 *       this campaign, so clients never have to special-case a 404 on the
 *       preference resource.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Effective preferences for this campaign
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CampaignCommunicationPreferences'
 *       401: { description: Authentication required }
 *       404: { description: Campaign not found }
 *   put:
 *     tags: [Campaigns — Communication Preferences]
 *     summary: Set one or more per-campaign communication preferences
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
 *             $ref: '#/components/schemas/CampaignCommunicationPreferencePatch'
 *     responses:
 *       200:
 *         description: Stored preferences
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CampaignCommunicationPreferences'
 *       400: { description: Malformed request }
 *       401: { description: Authentication required }
 *       404: { description: Campaign not found }
 *       422: { description: No recognised boolean channel was supplied }
 *       429: { description: Rate limit exceeded }
 *   patch:
 *     tags: [Campaigns — Communication Preferences]
 *     summary: Alias for PUT (the endpoint is a partial update either way)
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
 *             $ref: '#/components/schemas/CampaignCommunicationPreferencePatch'
 *     responses:
 *       200:
 *         description: Stored preferences
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CampaignCommunicationPreferences'
 *       400: { description: Malformed request }
 *       401: { description: Authentication required }
 *       404: { description: Campaign not found }
 *       422: { description: No recognised boolean channel was supplied }
 *       429: { description: Rate limit exceeded }
 *   delete:
 *     tags: [Campaigns — Communication Preferences]
 *     summary: Reset preferences for this campaign back to the defaults
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Default preferences (all channels enabled)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CampaignCommunicationPreferences'
 *       401: { description: Authentication required }
 *       404: { description: Campaign not found }
 *
 * @openapi
 * /api/campaigns/communication-preferences/channels:
 *   get:
 *     tags: [Campaigns — Communication Preferences]
 *     summary: List the communication channels this build supports
 *     description: >-
 *       Channel metadata so the UI renders labels and help text from one
 *       source instead of hardcoding them per client.
 *     responses:
 *       200:
 *         description: Supported channels with descriptions
 */

/**
 * GET /api/campaigns/communication-preferences/channels
 *
 * Declared before the parameterised routes so the literal path always wins.
 */
router.get('/communication-preferences/channels', (_req, res) => {
  res.json({
    channels: CHANNELS.map(channel => ({
      id: channel,
      description: CHANNEL_DESCRIPTIONS[channel],
    })),
  });
});

/**
 * GET /api/campaigns/:campaignId/communication-preferences
 */
router.get(
  '/:campaignId/communication-preferences',
  requireAuth,
  asyncHandler(loadCampaign),
  asyncHandler(async (req, res) => {
    res.json(await getPreferences(req.params.campaignId, req.user.userId));
  })
);

/**
 * Shared PUT/PATCH body. A body with no recognised boolean channel is
 * rejected with 422 rather than silently writing an empty override row.
 */
function handleWrite(req, res) {
  const body = req.body || {};
  return setPreferences(req.params.campaignId, req.user.userId, body).then(async result => {
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const channels = pickChannels(body);
    await auditPreferenceChange({
      userId: req.user.userId,
      campaignId: req.params.campaignId,
      channels,
      values: Object.fromEntries(channels.map(channel => [channel, body[channel] === true])),
      action: 'campaign_communication_preferences_updated',
      req,
    });
    return res.json(result.preferences);
  });
}

/**
 * PUT /api/campaigns/:campaignId/communication-preferences
 *
 * Body is a partial patch: `{ "milestones": false }`. Unknown keys and
 * non-boolean values are ignored, so a client cannot smuggle extra columns in.
 */
router.put(
  '/:campaignId/communication-preferences',
  requireAuth,
  preferenceWriteLimiter,
  asyncHandler(loadCampaign),
  asyncHandler(handleWrite)
);

/**
 * PATCH /api/campaigns/:campaignId/communication-preferences
 */
router.patch(
  '/:campaignId/communication-preferences',
  requireAuth,
  preferenceWriteLimiter,
  asyncHandler(loadCampaign),
  asyncHandler(handleWrite)
);

/**
 * DELETE /api/campaigns/:campaignId/communication-preferences
 *
 * Drops the override row so the contributor hears about this campaign exactly
 * as they did before muting anything. Idempotent: resetting a contributor who
 * never overrode anything still returns the defaults.
 */
router.delete(
  '/:campaignId/communication-preferences',
  requireAuth,
  asyncHandler(loadCampaign),
  asyncHandler(async (req, res) => {
    const preferences = await resetPreferences(req.params.campaignId, req.user.userId);
    await auditPreferenceChange({
      userId: req.user.userId,
      campaignId: req.params.campaignId,
      channels: CHANNELS,
      values: Object.fromEntries(CHANNELS.map(channel => [channel, true])),
      action: 'campaign_communication_preferences_reset',
      req,
    });
    res.json(preferences);
  })
);

module.exports = router;
