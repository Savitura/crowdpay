const db = require('../config/database');

// Follow campaign categories (#957). Unlike campaign_followers (one row per
// user+campaign with per-event toggles), a category follow is a bare
// subscription: the user wants new/active campaigns in that category surfaced
// in their weekly digest. Delivery preferences live on
// notification_preferences.category_digest, not on each follow row.

const VALID_CATEGORIES = [
  'technology',
  'community',
  'arts',
  'education',
  'environment',
  'health',
  'business',
  'open_source',
  'other',
];

const MAX_FOLLOWS_PER_USER = VALID_CATEGORIES.length;
const MAX_CATEGORY_DIGEST_CAMPAIGNS = 20;
const MAX_PER_CATEGORY_DIGEST_CAMPAIGNS = 5;

function normalizeCategory(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return VALID_CATEGORIES.includes(normalized) ? normalized : null;
}

/**
 * Follow a category. Idempotent: re-following (including concurrent
 * duplicate requests racing on the PK) resolves to the same row via
 * ON CONFLICT DO NOTHING + a follow-up SELECT.
 *
 * @returns {{category: string, following: true, created: boolean, created_at: string}}
 */
async function followCategory(userId, rawCategory) {
  const category = normalizeCategory(rawCategory);
  if (!category) {
    const err = new Error(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO category_follows (user_id, category)
     VALUES ($1, $2)
     ON CONFLICT (user_id, category) DO NOTHING
     RETURNING category, created_at`,
    [userId, category]
  );
  if (inserted.length) {
    return { category, following: true, created: true, created_at: inserted[0].created_at };
  }

  const { rows } = await db.query(
    `SELECT category, created_at FROM category_follows WHERE user_id = $1 AND category = $2`,
    [userId, category]
  );
  // Row must exist (we just hit the conflict branch), but guard anyway so a
  // concurrent delete still has deterministic behaviour.
  if (!rows.length) {
    const { rows: retried } = await db.query(
      `INSERT INTO category_follows (user_id, category)
       VALUES ($1, $2)
       ON CONFLICT (user_id, category) DO NOTHING
       RETURNING category, created_at`,
      [userId, category]
    );
    if (retried.length) {
      return { category, following: true, created: true, created_at: retried[0].created_at };
    }
    return { category, following: false, created: false, created_at: null };
  }
  return { category, following: true, created: false, created_at: rows[0].created_at };
}

async function unfollowCategory(userId, rawCategory) {
  const category = normalizeCategory(rawCategory);
  if (!category) {
    const err = new Error(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const { rowCount } = await db.query(
    'DELETE FROM category_follows WHERE user_id = $1 AND category = $2',
    [userId, category]
  );
  return rowCount > 0;
}

async function listFollowedCategories(userId) {
  const { rows } = await db.query(
    `SELECT category, created_at AS followed_at
     FROM category_follows
     WHERE user_id = $1
     ORDER BY created_at DESC, category ASC`,
    [userId]
  );
  return rows;
}

async function listFollowedCategoryNames(userId) {
  const rows = await listFollowedCategories(userId);
  return rows.map(row => row.category);
}

/**
 * Public discovery payload: every known category with live follower and
 * active-campaign counts. Single query so the list stays consistent.
 */
async function listCategoriesWithCounts() {
  const { rows } = await db.query(
    `SELECT
       cats.category,
       COUNT(DISTINCT cf.user_id)::int AS follower_count,
       COUNT(DISTINCT CASE
         WHEN c.status = 'active'
          AND c.deleted_at IS NULL
          AND COALESCE(c.is_hidden, FALSE) = FALSE
          AND COALESCE(c.is_flagged_duplicate, FALSE) = FALSE
         THEN c.id END)::int AS active_campaigns
     FROM (SELECT unnest($1::text[]) AS category) cats
     LEFT JOIN category_follows cf ON cf.category = cats.category
     LEFT JOIN campaigns c ON c.category = cats.category
     GROUP BY cats.category
     ORDER BY cats.category ASC`,
    [VALID_CATEGORIES]
  );
  return rows;
}

/**
 * New/active campaigns in the user's followed categories for the digest
 * window. Bounded per category and overall so a single popular category
 * cannot starve the digest or blow up email size.
 */
async function listNewCampaignsInCategories(categories, windowStart, windowEnd) {
  if (!categories.length) return [];
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.status, c.deadline, c.target_amount, c.raised_amount,
            c.asset_type, c.category, c.created_at
     FROM campaigns c
     WHERE c.category = ANY($1::text[])
       AND c.deleted_at IS NULL
       AND COALESCE(c.is_hidden, FALSE) = FALSE
       AND COALESCE(c.is_flagged_duplicate, FALSE) = FALSE
       AND c.status = 'active'
       AND c.created_at > $2
       AND c.created_at <= $3
     ORDER BY c.created_at DESC
     LIMIT $4`,
    [categories, windowStart.toISOString(), windowEnd.toISOString(), MAX_CATEGORY_DIGEST_CAMPAIGNS]
  );

  // Enforce the per-category cap in JS (keeps the SQL simple and portable).
  const perCategory = new Map();
  const capped = [];
  for (const row of rows) {
    const seen = perCategory.get(row.category) || 0;
    if (seen >= MAX_PER_CATEGORY_DIGEST_CAMPAIGNS) continue;
    perCategory.set(row.category, seen + 1);
    capped.push(row);
  }
  return capped;
}

module.exports = {
  VALID_CATEGORIES,
  MAX_FOLLOWS_PER_USER,
  MAX_CATEGORY_DIGEST_CAMPAIGNS,
  MAX_PER_CATEGORY_DIGEST_CAMPAIGNS,
  normalizeCategory,
  followCategory,
  unfollowCategory,
  listFollowedCategories,
  listFollowedCategoryNames,
  listCategoriesWithCounts,
  listNewCampaignsInCategories,
};
