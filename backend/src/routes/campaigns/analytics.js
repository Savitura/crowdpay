// backend/src/routes/campaigns/analytics.js
'use strict';

const crypto = require('crypto');

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { impactStatsLimiter } = require('../../middleware/rateLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const { parsePagination } = require('../../utils/pagination');

function createAnalyticsRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const auth = deps.auth || require('../../middleware/auth');
  const contributionExportService =
    deps.contributionExportService || require('../../services/contributionExportService');
  const analyticsService = deps.analyticsService || require('../../services/analyticsService');
  const ogImageService = deps.ogImageService || require('../../services/ogImageService');
  const campaignReportService =
    deps.campaignReportService || require('../../services/campaignReportService');
  const campaignReportPdf = deps.campaignReportPdf || require('../../services/campaignReportPdf');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth, optionalAuth } = auth;
  const { getCampaignAnalytics, getCampaignContributors, getCampaignBackers } = analyticsService;
  const { generateCampaignOgImage } = ogImageService;
  const { streamCampaignContributionExport } = contributionExportService;
  const { assembleReport, generateSignedUrl, verifySignedToken } = campaignReportService;
  const { streamCampaignReportPdf, reportFilename } = campaignReportPdf;
  const {
    campaignsCache,
    IMPACT_CACHE_TTL_MS,
    computeCampaignImpact,
    signImpactStats,
    requireCampaignMember,
  } = helpers;

  const isTestEnv = process.env.NODE_ENV === 'test';
  const shareLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isTestEnv ? 100000 : 20,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => req.user?.userId || ipKeyGenerator(req.ip),
    skip: () => isTestEnv,
  });

  const SHARE_DEDUP_WINDOW = '1 hour';

  router.get(
    '/:id/impact',
    impactStatsLimiter,
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;
      const impact = await campaignsCache.wrap(
        `impact:${campaignId}`,
        () => computeCampaignImpact(campaignId),
        IMPACT_CACHE_TTL_MS
      );

      if (!impact) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');

      if (req.query.sign === '1' || req.query.signed === 'true') {
        if (!process.env.PLATFORM_SECRET_KEY) {
          return res.status(503).json({ error: 'Impact signing is not configured' });
        }
        const { signed_payload, signature, public_key } = signImpactStats(impact);
        return res.json({ ...impact, signed_payload, signature, public_key });
      }

      res.json(impact);
    })
  );

  const serveOgImage = asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.target_amount, c.raised_amount, c.asset_type, c.status, c.deleted_at,
            u.full_name AS creator_name, u.email AS creator_email
     FROM campaigns c
     LEFT JOIN users u ON u.id = c.creator_id
     WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length || rows[0].deleted_at) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = rows[0];
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const campaignUrl = `${frontendUrl}/campaigns/${campaign.id}`;
    const creatorName =
      campaign.creator_name ||
      (campaign.creator_email ? campaign.creator_email.split('@')[0] : 'Creator');

    const pngBuffer = await generateCampaignOgImage({
      title: campaign.title,
      creatorName,
      raisedAmount: campaign.raised_amount,
      targetAmount: campaign.target_amount,
      assetType: campaign.asset_type,
      campaignUrl,
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(pngBuffer);
  });

  router.get(
    '/:id/backers',
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;
      const { rows: campaignRows } = await db.query(
        'SELECT show_backer_amounts FROM campaigns WHERE id = $1',
        [campaignId]
      );
      if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
      const { show_backer_amounts } = campaignRows[0];

      const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

      const countResult = await db.query(
        'SELECT COUNT(*)::int AS total FROM contributions WHERE campaign_id = $1',
        [campaignId]
      );
      const total = countResult.rows[0].total;

      const query = `
    SELECT 
      ctr.display_name,
      ctr.sender_public_key,
      COALESCE(u.contributor_privacy, 'full') AS contributor_privacy,
      ${show_backer_amounts ? 'ctr.amount,' : ''}
      ctr.asset,
      ctr.created_at
    FROM contributions ctr
    LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
    WHERE ctr.campaign_id = $1
    ORDER BY ctr.created_at DESC
    LIMIT $2 OFFSET $3
  `;
      const { rows } = await db.query(query, [campaignId, limit, offset]);

      // Apply contributor privacy settings
      const filteredRows = rows.map(row => {
        const privacy = row.contributor_privacy || 'full';
        const campaignHidesAmounts = !show_backer_amounts;

        // Apply the more restrictive setting
        if (privacy === 'anonymous' || campaignHidesAmounts) {
          return {
            display_name: null,
            sender_public_key: null,
            amount: null,
            asset: row.asset,
            created_at: row.created_at,
            contributor_privacy: privacy,
          };
        }

        if (privacy === 'amount_only') {
          return {
            display_name: null,
            sender_public_key: null,
            amount: row.amount,
            asset: row.asset,
            created_at: row.created_at,
            contributor_privacy: privacy,
          };
        }

        // full mode - show everything (subject to campaign-level show_backer_amounts)
        return {
          display_name: row.display_name,
          sender_public_key: row.sender_public_key,
          amount: row.amount,
          asset: row.asset,
          created_at: row.created_at,
          contributor_privacy: privacy,
        };
      });

      res.json({ data: filteredRows, total, limit, offset });
    })
  );

  // Download contributor fulfillment data for campaign owners/admins.

  router.get(
    '/:id/contributions/export',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      await streamCampaignContributionExport({
        campaignId: req.params.id,
        res,
        runner: db,
      });
    })
  );

  // SSE stream for real-time campaign funding updates

  router.get(
    '/:id/analytics',
    requireAuth,
    requireCampaignMember(),
    asyncHandler(async (req, res) => {
      const data = await getCampaignAnalytics(req.params.id);
      if (!data) return res.status(404).json({ error: 'Campaign not found' });
      res.json(data);
    })
  );

  // GET /campaigns/:id/analytics/contributors - country breakdown, repeat vs first-time

  router.get(
    '/:id/analytics/contributors',
    requireAuth,
    requireCampaignMember(),
    asyncHandler(async (req, res) => {
      const data = await getCampaignContributors(req.params.id);
      res.json(data);
    })
  );

  // GET /campaigns/:id/analytics/backers - backer growth, leaderboard, repeat rate

  router.get(
    '/:id/analytics/backers',
    requireAuth,
    requireCampaignMember(),
    asyncHandler(async (req, res) => {
      const data = await getCampaignBackers(req.params.id);
      res.json(data);
    })
  );

  // GET /campaigns/:id/referral - get or create a referral code for the authenticated user

  router.post(
    '/:id/share',
    shareLimiter,
    optionalAuth,
    asyncHandler(async (req, res) => {
      const { rows: campaignRows } = await db.query(
        'SELECT id, share_count FROM campaigns WHERE id = $1',
        [req.params.id]
      );
      if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });

      const actorHash = crypto
        .createHash('sha256')
        .update(req.user?.userId ? `user:${req.user.userId}` : `ip:${req.ip}`)
        .digest('hex');

      const { rows: dedupRows } = await db.query(
        `INSERT INTO campaign_share_dedup (campaign_id, actor_hash, last_shared_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (campaign_id, actor_hash) DO UPDATE
       SET last_shared_at = NOW()
       WHERE campaign_share_dedup.last_shared_at < NOW() - INTERVAL '${SHARE_DEDUP_WINDOW}'
     RETURNING campaign_id`,
        [req.params.id, actorHash]
      );

      if (!dedupRows.length) {
        // Duplicate share from this actor within the window - don't recount it.
        return res.json({ share_count: campaignRows[0].share_count });
      }

      const { rows } = await db.query(
        'UPDATE campaigns SET share_count = share_count + 1 WHERE id = $1 RETURNING share_count',
        [req.params.id]
      );
      res.json({ share_count: rows[0].share_count });
    })
  );

  // ── Stretch Goals (#585) ──────────────────────────────────────────────────────

  // GET /campaigns/:id/stretch-goals - public list

  router.get(
    '/:id/report/export',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const report = await assembleReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const filename = reportFilename(report.campaign.id, report.campaign.title);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      streamCampaignReportPdf(report, res);
    })
  );

  // Generate a shareable signed URL for the report (owner or admin only)

  router.get(
    '/:id/report/share',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const report = await assembleReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const shareableUrl = generateSignedUrl(req.params.id, baseUrl);

      res.json({ url: shareableUrl, expires_in_seconds: 24 * 60 * 60 });
    })
  );

  // Serve a PDF report via signed URL (no auth required - token-verified)

  router.get(
    '/:id/report/share/:token',
    asyncHandler(async (req, res) => {
      if (!verifySignedToken(req.params.token, req.params.id)) {
        return res.status(403).json({ error: 'Invalid or expired share link' });
      }

      const report = await assembleReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const filename = reportFilename(report.campaign.id, report.campaign.title);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      streamCampaignReportPdf(report, res);
    })
  );

  // Soroban treasury endpoints (#687) live in their own router to keep this file
  // from growing further; they are mounted under /api/campaigns/:id/treasury.
  router.use('/:id/treasury', require('../treasury'));

  let _refundService;
  function getRefundService() {
    if (!_refundService) _refundService = require('../services/refundService');
    return _refundService;
  }

  return router;
}

module.exports = createAnalyticsRouter;
module.exports.createAnalyticsRouter = createAnalyticsRouter;
