const db = require('../config/database');
const cache = require('../utils/cache');
const logger = require('../config/logger');

const FACETS_CACHE_PREFIX = 'campaigns:facets';
const FACETS_CACHE_KEY = 'campaigns:facets';
const CATEGORY_FACETS_CACHE_KEY = 'campaigns:facets:category';
const COUNTRY_FACETS_CACHE_KEY = 'campaigns:facets:country';
const DEFAULT_FACETS_TTL_MS = 5 * 60 * 1000; // 5 minutes

const BASE_FACETS_WHERE = `
  c.deleted_at IS NULL
  AND c.is_flagged_duplicate = FALSE
  AND c.is_hidden = FALSE
  AND c.status = 'active'
`;

/**
 * Directly compute category, asset, country, funding, and verified creator
 * facet distributions over the active, publicly visible campaign set.
 *
 * @param {object} [client] Optional DB connection or query runner (defaults to db)
 * @returns {Promise<{
 *   categories: Array<{ category: string, count: number }>,
 *   assets: Array<{ asset_type: string, count: number }>,
 *   countries: Array<{ country: string, count: number }>,
 *   funding: { min: number, max: number },
 *   verified_creators: number
 * }>}
 */
async function computeCampaignFacets(client = null) {
  const runner = client || db;

  const [categories, assets, countries, funding, verified] = await Promise.all([
    runner.query(
      `SELECT category, COUNT(*)::int AS count
       FROM campaigns c
       WHERE ${BASE_FACETS_WHERE} AND category IS NOT NULL
       GROUP BY category ORDER BY count DESC`
    ),
    runner.query(
      `SELECT asset_type, COUNT(*)::int AS count
       FROM campaigns c
       WHERE ${BASE_FACETS_WHERE}
       GROUP BY asset_type ORDER BY count DESC`
    ),
    runner.query(
      `SELECT country, COUNT(*)::int AS count
       FROM campaigns c
       WHERE ${BASE_FACETS_WHERE} AND country IS NOT NULL
       GROUP BY country ORDER BY count DESC`
    ),
    runner.query(
      `SELECT COALESCE(MIN(raised_amount), 0)::numeric AS min_funding,
              COALESCE(MAX(raised_amount), 0)::numeric AS max_funding
       FROM campaigns c
       WHERE ${BASE_FACETS_WHERE}`
    ),
    runner.query(
      `SELECT COUNT(*)::int AS count
       FROM campaigns c
       JOIN users u ON u.id = c.creator_id
       WHERE ${BASE_FACETS_WHERE} AND u.kyc_status = 'verified'`
    ),
  ]);

  return {
    categories: categories.rows || [],
    assets: assets.rows || [],
    countries: countries.rows || [],
    funding: {
      min: Number(funding.rows?.[0]?.min_funding || 0),
      max: Number(funding.rows?.[0]?.max_funding || 0),
    },
    verified_creators: Number(verified.rows?.[0]?.count || 0),
  };
}

/**
 * Retrieve campaign discovery facets, serving from process cache when available.
 *
 * @param {object} [options]
 * @param {object} [options.client]       Optional DB client for querying
 * @param {boolean} [options.forceRefresh] Force recomputation and cache refresh
 * @param {number} [options.ttlMs]        TTL in milliseconds (defaults to 5 minutes)
 */
async function getCampaignFacets({
  client = null,
  forceRefresh = false,
  ttlMs = DEFAULT_FACETS_TTL_MS,
} = {}) {
  if (forceRefresh) {
    cache.invalidate(FACETS_CACHE_KEY);
    cache.invalidate(CATEGORY_FACETS_CACHE_KEY);
    cache.invalidate(COUNTRY_FACETS_CACHE_KEY);
  }

  const facets = await cache.wrap(
    FACETS_CACHE_KEY,
    async () => {
      const computed = await computeCampaignFacets(client);
      cache.set(CATEGORY_FACETS_CACHE_KEY, computed.categories, ttlMs);
      cache.set(COUNTRY_FACETS_CACHE_KEY, computed.countries, ttlMs);
      return computed;
    },
    ttlMs
  );

  return facets;
}

/**
 * Retrieve cached category facet counts.
 */
async function getCategoryFacets({
  client = null,
  forceRefresh = false,
  ttlMs = DEFAULT_FACETS_TTL_MS,
} = {}) {
  if (!forceRefresh) {
    const cached = cache.get(CATEGORY_FACETS_CACHE_KEY);
    if (cached !== undefined) {
      return cached;
    }
  }

  const facets = await getCampaignFacets({ client, forceRefresh, ttlMs });
  return facets.categories;
}

/**
 * Retrieve cached country facet counts.
 */
async function getCountryFacets({
  client = null,
  forceRefresh = false,
  ttlMs = DEFAULT_FACETS_TTL_MS,
} = {}) {
  if (!forceRefresh) {
    const cached = cache.get(COUNTRY_FACETS_CACHE_KEY);
    if (cached !== undefined) {
      return cached;
    }
  }

  const facets = await getCampaignFacets({ client, forceRefresh, ttlMs });
  return facets.countries;
}

/**
 * Explicitly invalidate all cached campaign facet data (categories, countries, assets, funding).
 * Should be called whenever a campaign is created, updated, deleted, has its status changed,
 * or when creator KYC status changes.
 *
 * @returns {{ success: boolean, invalidatedAt: string }}
 */
function invalidateCampaignFacets() {
  cache.invalidate(FACETS_CACHE_KEY);
  cache.invalidate(CATEGORY_FACETS_CACHE_KEY);
  cache.invalidate(COUNTRY_FACETS_CACHE_KEY);
  cache.invalidatePrefix(FACETS_CACHE_PREFIX);

  logger.debug?.('Campaign category and country facets cache explicitly invalidated');

  return {
    success: true,
    invalidatedAt: new Date().toISOString(),
  };
}

module.exports = {
  computeCampaignFacets,
  getCampaignFacets,
  getCategoryFacets,
  getCountryFacets,
  invalidateCampaignFacets,
  FACETS_CACHE_KEY,
  CATEGORY_FACETS_CACHE_KEY,
  COUNTRY_FACETS_CACHE_KEY,
  FACETS_CACHE_PREFIX,
  DEFAULT_FACETS_TTL_MS,
};
