// backend/src/routes/campaigns/discovery.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { parsePagination } = require('../../utils/pagination');
const {
  PUBLIC_CAMPAIGN_SELECT,
  publicCampaignColumnList,
  stripInternalCampaignFields,
} = require('../../lib/publicCampaignColumns');

function createDiscoveryRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const userDashboardService =
    deps.userDashboardService || require('../../services/userDashboardService');
  const trendingService = deps.trendingService || require('../../services/trendingService');
  const campaignRecommendationService =
    deps.campaignRecommendationService || require('../../services/campaignRecommendationService');
  const validation = deps.validation || require('../../middleware/validation');
  const auth = deps.auth || require('../../middleware/auth');
  const campaignFacetService =
    deps.campaignFacetService || require('../../services/campaignFacetService');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { campaignsCache } = helpers;
  const { getRecommendedCampaigns } = campaignRecommendationService;
  const { getTrendingCampaigns } = trendingService;
  const { listCreatorCampaigns } = userDashboardService;
  const { getCampaignFacets, invalidateCampaignFacets } = campaignFacetService;
  const { getCampaignsValidation, validateRequest } = validation;
  const { requireAuth, optionalAuth, requireRole } = auth;

  router.get(
    '/featured',
    asyncHandler(async (req, res) => {
      const rows = await campaignsCache.wrap('featured', async () => {
        const { rows: featured } = await db.query(
          `SELECT
           c.id, c.title, c.description, c.target_amount, c.raised_amount,
           c.asset_type, c.deadline, c.created_at, c.cover_image_url,
           u.name AS creator_name,
           u.verification_status AS creator_verification_status,
           u.verification_tier AS creator_verification_tier,
           (
             SELECT COUNT(DISTINCT sender_public_key)
             FROM contributions
             WHERE campaign_id = c.id
           )::int AS backer_count,
           ROUND(
             (c.raised_amount / NULLIF(c.target_amount, 0)) * 100, 1
           ) AS progress_pct
         FROM campaigns c
         JOIN users u ON u.id = c.creator_id
         WHERE c.status = 'active'
           AND c.deleted_at IS NULL
           AND c.deadline > NOW()
         ORDER BY backer_count DESC, c.raised_amount DESC
         LIMIT 6`
        );
        return featured;
      });

      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
      res.json(rows);
    })
  );

  /**
   * GET /api/campaigns/categories
   * Returns campaigns grouped by asset_type with counts.
   * This data rarely changes - cached for 5 minutes.
   */

  router.get(
    '/categories',
    asyncHandler(async (req, res) => {
      const rows = await campaignsCache.wrap(
        'categories',
        async () => {
          const { rows: cats } = await db.query(
            `SELECT
           asset_type                       AS category,
           COUNT(*)::int                    AS total_campaigns,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
           COALESCE(SUM(raised_amount), 0)  AS total_raised
         FROM campaigns
         WHERE deleted_at IS NULL
         GROUP BY asset_type
         ORDER BY active_campaigns DESC`,
            [],
            { ttlMs: 5 * 60_000 }
          );
          return cats;
        },
        5 * 60_000
      );

      res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
      res.json(rows);
    })
  );

  router.get(
    '/recommended',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { limit } = parsePagination(req.query, { limit: 6, max: 12 });
      const rows = await getRecommendedCampaigns(req.user.userId, { limit });
      res.json(rows);
    })
  );

  router.get(
    '/',
    getCampaignsValidation,
    validateRequest,
    asyncHandler(async (req, res) => {
      /**
       * @openapi
       * /api/campaigns:
       *   get:
       *     tags: [Campaigns]
       *     summary: List campaigns
       *     parameters:
       *       - in: query
       *         name: status
       *         schema: { type: string }
       *       - in: query
       *         name: asset
       *         schema: { type: string }
       *       - in: query
       *         name: search
       *         schema: { type: string }
       *       - in: query
       *         name: sort
       *         schema: { type: string }
       *       - in: query
       *         name: limit
       *         schema: { type: integer, minimum: 1, maximum: 50 }
       *       - in: query
       *         name: offset
       *         schema: { type: integer, minimum: 0 }
       *     responses:
       *       200:
       *         description: OK
       *         content:
       *           application/json:
       *             schema:
       *               type: object
       *               properties:
       *                 total: { type: integer }
       *                 limit: { type: integer }
       *                 offset: { type: integer }
       *                 campaigns:
       *                   type: array
       *                   items:
       *                     type: object
       */
      const { search, status, asset, category, min_progress, sort = 'newest' } = req.query;
      const { min_funding, max_funding, deadline_within, creator_verified, country } = req.query;
      const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });
      const filters = [];
      const params = [];

      // Exclude deleted and hidden campaigns from public listing
      filters.push(`c.deleted_at IS NULL`);
      filters.push(`c.is_flagged_duplicate = FALSE`);
      filters.push(`c.is_hidden = FALSE`);

      if (status) {
        params.push(status);
        filters.push(`c.status = $${params.length}`);
      } else {
        filters.push(`c.status = 'active'`);
      }
      if (asset) {
        params.push(asset);
        filters.push(`c.asset_type = $${params.length}`);
      }
      if (category) {
        params.push(category);
        filters.push(`c.category = $${params.length}`);
      }
      if (min_progress) {
        params.push(Number(min_progress));
        // Progress is (raised_amount / target_amount) * 100
        filters.push(`(c.raised_amount / NULLIF(c.target_amount, 0)) * 100 >= $${params.length}`);
      }
      // Funding range facet - filter on amount raised so far.
      if (min_funding !== undefined && min_funding !== '' && Number.isFinite(Number(min_funding))) {
        params.push(Number(min_funding));
        filters.push(`c.raised_amount >= $${params.length}`);
      }
      if (max_funding !== undefined && max_funding !== '' && Number.isFinite(Number(max_funding))) {
        params.push(Number(max_funding));
        filters.push(`c.raised_amount <= $${params.length}`);
      }
      // Deadline proximity facet - campaigns ending within N days from now.
      if (
        deadline_within !== undefined &&
        deadline_within !== '' &&
        Number.isFinite(Number(deadline_within))
      ) {
        params.push(Number(deadline_within));
        filters.push(
          `c.deadline IS NOT NULL AND c.deadline >= CURRENT_DATE AND c.deadline <= CURRENT_DATE + ($${params.length}::int) * INTERVAL '1 day'`
        );
      }
      // Creator reputation facet - currently backed by KYC verification status.
      if (creator_verified === 'true' || creator_verified === '1') {
        filters.push(`u.kyc_status = 'verified'`);
      }
      // Geographic location facet.
      if (country) {
        params.push(country);
        filters.push(`c.country = $${params.length}`);
      }
      let searchParamIdx = null;
      if (search) {
        params.push(search);
        searchParamIdx = params.length;
        filters.push(`c.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
      }

      const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const countQuery = `SELECT COUNT(*)::int AS total FROM campaigns c JOIN users u ON u.id = c.creator_id ${whereClause}`;
      const countResult = await db.query(countQuery, params);
      const total = countResult.rows[0]?.total || 0;

      const sortExpressions = {
        newest: 'c.created_at DESC',
        trending: 'COALESCE(ctr_trending.recent_count, 0) DESC, c.created_at DESC',
        ending_soon: 'c.deadline ASC NULLS LAST',
        most_funded: 'c.raised_amount DESC',
        most_backed: 'COALESCE(con.total_contributions, 0) DESC',
        closest_to_goal:
          '(c.raised_amount / NULLIF(c.target_amount, 0)) DESC NULLS LAST, c.raised_amount DESC',
      };
      if (searchParamIdx !== null) {
        sortExpressions.relevance = `ts_rank(c.search_vector, websearch_to_tsquery('english', $${searchParamIdx})) DESC, c.created_at DESC`;
      }
      // A search without an explicit sort ranks by relevance; explicit sorts always win.
      const effectiveSort =
        searchParamIdx !== null && req.query.sort === undefined ? 'relevance' : sort;
      const orderBy = sortExpressions[effectiveSort] || sortExpressions.newest;

      const query = `
    SELECT ${PUBLIC_CAMPAIGN_SELECT},
           u.name AS creator_name,
           u.kyc_status AS creator_kyc_status,
           u.verification_status AS creator_verification_status,
           u.verification_tier AS creator_verification_tier,
           COALESCE(cu.updates_count, 0)::int AS updates_count,
           COALESCE(con.contributor_count, 0)::int AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    LEFT JOIN (
      SELECT campaign_id, COUNT(*)::int AS updates_count
      FROM campaign_updates
      GROUP BY campaign_id
    ) cu ON cu.campaign_id = c.id
    LEFT JOIN (
      SELECT campaign_id,
             COUNT(DISTINCT sender_public_key)::int AS contributor_count,
             COUNT(*)::int AS total_contributions
      FROM contributions
      GROUP BY campaign_id
    ) con ON con.campaign_id = c.id
    LEFT JOIN (
      SELECT campaign_id, COUNT(*)::int AS recent_count
      FROM contributions
      WHERE created_at >= NOW() - INTERVAL '48 hours'
      GROUP BY campaign_id
    ) ctr_trending ON ctr_trending.campaign_id = c.id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;
      const result = await db.query(query, [...params, limit, offset]);

      // The listing endpoint is public: strip any internal column a widened query
      // might have selected (fraud_*, content_fingerprint, wallet_secret_encrypted).
      res.json({
        total,
        limit,
        offset,
        campaigns: result.rows.map(stripInternalCampaignFields),
      });
    })
  );

  // GET /campaigns/facets - available filter facets with counts for the discovery UI.
  // Computed over the publicly listable, active campaign set so the UI can render
  // faceted controls (categories, assets, countries) and sensible funding bounds.

  router.get(
    '/facets',
    asyncHandler(async (req, res) => {
      const forceRefresh = req.query.refresh === 'true';
      const facets = await getCampaignFacets({ client: db, forceRefresh });
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
      res.json(facets);
    })
  );

  // POST /campaigns/facets/invalidate — Explicitly clear cached discovery facet data
  router.post(
    '/facets/invalidate',
    requireAuth,
    requireRole('admin', 'creator'),
    asyncHandler(async (req, res) => {
      const result = invalidateCampaignFacets();
      res.json({
        message: 'Campaign facets cache invalidated',
        ...result,
      });
    })
  );

  router.get(
    '/mine',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { page, limit, fields } = req.query;
      const result = await listCreatorCampaigns(req.user.userId, { page, limit, fields });
      res.json(result);
    })
  );

  // ── Campaign draft auto-save ──────────────────────────────────────────────

  router.get(
    '/trending',
    asyncHandler(async (req, res) => {
      const { limit } = parsePagination(req.query, { limit: 20, max: 20 });
      const campaigns = await getTrendingCampaigns({ limit });
      res.json({ campaigns });
    })
  );

  router.get(
    '/featured',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(`
    SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
           c.asset_type, c.status, c.deadline, c.featured_note,
           u.name AS creator_name,
           COALESCE(con.contributor_count, 0)::int AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    LEFT JOIN (
      SELECT campaign_id, COUNT(*)::int AS contributor_count
      FROM contributions
      GROUP BY campaign_id
    ) con ON con.campaign_id = c.id
    WHERE c.featured = TRUE AND c.status = 'active' AND c.deleted_at IS NULL AND c.is_flagged_duplicate = FALSE AND c.is_hidden = FALSE
    ORDER BY c.featured_at DESC
    LIMIT 3
  `);
      res.json(rows);
    })
  );

  // Add campaign to the current user's favorites/wishlist

  router.get(
    '/categories',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(`
    SELECT category, COUNT(*)::int AS count
    FROM campaigns
    WHERE status = 'active' AND deleted_at IS NULL AND is_flagged_duplicate = FALSE AND is_hidden = FALSE
    GROUP BY category
    ORDER BY category ASC
  `);
      res.json(rows);
    })
  );

  return router;
}

module.exports = createDiscoveryRouter;
module.exports.createDiscoveryRouter = createDiscoveryRouter;
