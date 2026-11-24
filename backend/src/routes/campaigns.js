// backend/src/routes/campaigns.js
'use strict';

const db = require('../config/database');
const logger = require('../config/logger');
const auth = require('../middleware/auth');
const validation = require('../middleware/validation');
const stellarService = require('../services/stellarService');
const campaignStatusService = require('../services/campaignStatusService');
const campaignStatusActions = require('../services/campaignStatusActions');
const sorobanService = require('../services/sorobanService');
const storage = require('../services/storage');
const kycProvider = require('../services/kycProvider');
const userDashboardService = require('../services/userDashboardService');
const trendingService = require('../services/trendingService');
const campaignRecommendationService = require('../services/campaignRecommendationService');
const campaignPublishing = require('../services/campaignPublishing');
const rewardTierService = require('../services/rewardTierService');
const contributionExportService = require('../services/contributionExportService');
const analyticsService = require('../services/analyticsService');
const campaignReportService = require('../services/campaignReportService');
const campaignReportPdf = require('../services/campaignReportPdf');
const campaignInviteService = require('../services/campaignInviteService');
const campaignPermissions = require('../lib/campaignPermissions');
const referral = require('../services/referral');
const ogImageService = require('../services/ogImageService');
const ledgerMonitor = require('../services/ledgerMonitor');
const walletSecrets = require('../services/walletSecrets');
const walletService = require('../services/walletService');
const webhookDispatcher = require('../services/webhookDispatcher');
const emailService = require('../services/emailService');
const draftVersionService = require('../services/campaignDraftVersionService');
const campaignFacetService = require('../services/campaignFacetService');

const createCampaignsRouter = require('./campaigns/index');

const deps = {
  db,
  logger,
  auth,
  validation,
  stellarService,
  campaignStatusService,
  campaignStatusActions,
  sorobanService,
  storage,
  kycProvider,
  userDashboardService,
  trendingService,
  campaignRecommendationService,
  campaignPublishing,
  rewardTierService,
  contributionExportService,
  analyticsService,
  campaignReportService,
  campaignReportPdf,
  campaignInviteService,
  campaignPermissions,
  referral,
  ogImageService,
  ledgerMonitor,
  walletSecrets,
  walletService,
  webhookDispatcher,
  emailService,
  draftVersionService,
  campaignFacetService,
};

const router = createCampaignsRouter(deps);

/**
 * @openapi
 * /api/campaigns/{id}/referrals:
 *   post:
 *     tags: [Campaigns]
 *     summary: Enable or update the campaign's referral program (creator only)
 *     description: >
 *       Creates the referral program for a campaign, or updates the terms of an
 *       existing one. Updating the commission rate does not invalidate referral
 *       links that have already been issued.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [commissionPercentage, maxReferrers]
 *             properties:
 *               commissionPercentage:
 *                 type: number
 *                 description: Percentage of each referred contribution paid to the referrer (1-20)
 *                 example: 10
 *               maxReferrers:
 *                 type: integer
 *                 description: Maximum number of referrers that may claim a link (1-100)
 *                 example: 25
 *     responses:
 *       201: { description: Referral program created or updated }
 *       400: { description: commissionPercentage or maxReferrers outside the allowed range }
 *       403: { description: Forbidden }
 *       404: { description: Campaign not found }
 */

/**
 * @openapi
 * /api/campaigns/{id}/referrals/program:
 *   get:
 *     tags: [Campaigns]
 *     summary: Get the campaign's public referral program terms
 *     description: >
 *       Public endpoint used by the share page to show the commission rate and
 *       how many of the referrer slots have already been claimed.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Program terms plus the current referrer_count }
 *       404: { description: This campaign does not have a referral program }
 */

/**
 * @openapi
 * /api/campaigns/{id}/referrals/links:
 *   post:
 *     tags: [Campaigns]
 *     summary: Claim a trackable referral link for the authenticated user
 *     description: >
 *       Issues a unique 8-character referral code for the caller. The call is
 *       idempotent: a user who already holds a link for this campaign gets the
 *       same code back with a 200 instead of a 201. Contributions made through
 *       the returned shareUrl are attributed on-chain via the Stellar
 *       transaction memo (`ref:<code>`).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The caller already held a link; the existing code is returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: string, example: "a1b2c3d4" }
 *                 shareUrl: { type: string, example: "https://crowdpay.com/c/<campaignId>?ref=a1b2c3d4" }
 *       201: { description: A new referral link was issued }
 *       404: { description: This campaign does not have a referral program }
 *       409: { description: REFERRER_LIMIT_REACHED - the maxReferrers cap is full }
 */

/**
 * @openapi
 * /api/campaigns/{id}/referrals/commissions:
 *   get:
 *     tags: [Campaigns]
 *     summary: Referrer breakdown with commission owed (creator only)
 *     description: >
 *       Powers the campaign analytics Referrals tab: every referrer with their
 *       referred contribution count, total referred amount, and the commission
 *       still owed to them at the next withdrawal.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Program terms and the per-referrer commission breakdown }
 *       403: { description: Forbidden }
 *       404: { description: This campaign does not have a referral program }
 */

module.exports = router;
module.exports.createCampaignsRouter = createCampaignsRouter;
