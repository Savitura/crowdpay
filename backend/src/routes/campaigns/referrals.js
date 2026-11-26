// backend/src/routes/campaigns/referrals.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');

function createReferralsRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const auth = deps.auth || require('../../middleware/auth');
  const referral = deps.referral || require('../../services/referral');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth } = auth;
  const { createReferralProgram, createReferralLink, getReferralProgram, listCampaignReferrers } =
    referral;
  const { generateUniqueReferralCode, requireCampaignMember } = helpers;

  router.get(
    '/:id/referral',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows: existing } = await db.query(
        `SELECT cr.id, cr.referral_code, cr.click_count, cr.contribution_count
     FROM campaign_referrals cr
     WHERE cr.campaign_id = $1 AND cr.referrer_user_id = $2`,
        [req.params.id, req.user.userId]
      );

      if (existing.length) {
        const row = existing[0];
        return res.json({
          referral_code: row.referral_code,
          referral_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}?ref=${row.referral_code}`,
          click_count: row.click_count,
          contribution_count: row.contribution_count,
        });
      }

      const code = await generateUniqueReferralCode(db);
      const { rows: inserted } = await db.query(
        `INSERT INTO campaign_referrals (campaign_id, referrer_user_id, referral_code)
     VALUES ($1, $2, $3)
     RETURNING referral_code, click_count, contribution_count`,
        [req.params.id, req.user.userId, code]
      );
      const row = inserted[0];
      res.status(201).json({
        referral_code: row.referral_code,
        referral_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}?ref=${row.referral_code}`,
        click_count: row.click_count,
        contribution_count: row.contribution_count,
      });
    })
  );

  // GET /campaigns/:id/referrals - creator only; list top referrers

  router.get(
    '/:id/referrals',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT cr.referral_code, cr.click_count, cr.contribution_count, cr.created_at,
            u.name AS referrer_name, u.id AS referrer_id
     FROM campaign_referrals cr
     JOIN users u ON u.id = cr.referrer_user_id
     WHERE cr.campaign_id = $1
     ORDER BY cr.contribution_count DESC, cr.click_count DESC`,
        [req.params.id]
      );
      res.json(rows);
    })
  );

  // ── Referral & affiliate program (#675) ──────────────────────────────────────

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
  // POST /campaigns/:id/referrals - creator enables referrals on the campaign

  router.post(
    '/:id/referrals',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { commissionPercentage, maxReferrers } = req.body || {};
      try {
        const program = await createReferralProgram(req.params.id, {
          commissionPercentage,
          maxReferrers,
        });
        res.status(201).json(program);
      } catch (err) {
        if (err.statusCode === 400) {
          return res.status(400).json({ error: err.message, code: err.code });
        }
        throw err;
      }
    })
  );

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
  // GET /campaigns/:id/referrals/program - public program terms

  router.get(
    '/:id/referrals/program',
    asyncHandler(async (req, res) => {
      const program = await getReferralProgram(req.params.id);
      if (!program)
        return res.status(404).json({ error: 'This campaign does not have a referral program' });
      const { rows } = await db.query(
        'SELECT COUNT(*)::int AS total FROM referral_links WHERE campaign_id = $1',
        [req.params.id]
      );
      res.json({ ...program, referrer_count: rows[0]?.total || 0 });
    })
  );

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
  // POST /campaigns/:id/referrals/links - any registered user claims a referrer link

  router.post(
    '/:id/referrals/links',
    requireAuth,
    asyncHandler(async (req, res) => {
      try {
        const { code, shareUrl, created } = await createReferralLink({
          campaignId: req.params.id,
          userId: req.user.userId,
        });
        res.status(created ? 201 : 200).json({ code, shareUrl });
      } catch (err) {
        if (err.statusCode === 409 || err.statusCode === 404) {
          return res.status(err.statusCode).json({ error: err.message, code: err.code });
        }
        throw err;
      }
    })
  );

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
  // GET /campaigns/:id/referrals/commissions - creator-only referrer breakdown

  router.get(
    '/:id/referrals/commissions',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const data = await listCampaignReferrers(req.params.id);
      if (!data.program)
        return res.status(404).json({ error: 'This campaign does not have a referral program' });
      res.json(data);
    })
  );

  return router;
}

module.exports = createReferralsRouter;
module.exports.createReferralsRouter = createReferralsRouter;
