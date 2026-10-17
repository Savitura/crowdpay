const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { logAuditEvent } = require('../services/auditService');
const {
  VALID_CATEGORIES,
  normalizeCategory,
  followCategory,
  unfollowCategory,
  listFollowedCategories,
  listCategoriesWithCounts,
} = require('../services/categoryFollowService');

/**
 * @openapi
 * tags:
 *   - name: Categories
 *     description: Follow campaign categories and receive matching campaigns in the weekly digest
 */

// Abuse guard: follows are cheap writes keyed by user, so limit per IP while
// keeping the ceiling generous for shared networks.
const categoryFollowLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `${req.user?.userId || ipKeyGenerator(req.ip)}`,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
  },
});

function validationError(req, res) {
  const result = validationResult(req);
  if (result.isEmpty()) return false;
  const fields = result.array().map(e => ({ field: e.path || e.param, message: e.msg }));
  res.status(400).json({
    error: { code: 'VALIDATION_ERROR', message: fields[0]?.message || 'Validation failed', fields },
  });
  return true;
}

const categoryBodyValidation = [
  body('category')
    .exists()
    .withMessage('category is required')
    .bail()
    .isString()
    .withMessage('category must be a string')
    .bail()
    .customSanitizer(value => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    .isIn(VALID_CATEGORIES)
    .withMessage(`category must be one of: ${VALID_CATEGORIES.join(', ')}`),
];

const categoryParamValidation = [
  param('category')
    .customSanitizer(value => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    .isIn(VALID_CATEGORIES)
    .withMessage(`category must be one of: ${VALID_CATEGORIES.join(', ')}`),
];

/**
 * @openapi
 * /api/categories:
 *   get:
 *     tags: [Categories]
 *     summary: List followable campaign categories
 *     description: >
 *       Returns every campaign category with live follower and active-campaign
 *       counts. When authenticated, each entry also carries `following` for the
 *       current user. Public; cached for 60 seconds.
 *     responses:
 *       200:
 *         description: Category list with counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   category: { type: string }
 *                   follower_count: { type: integer }
 *                   active_campaigns: { type: integer }
 *                   following: { type: boolean }
 */
router.get(
  '/categories',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const counts = await listCategoriesWithCounts();
    let following = new Set();
    if (req.user?.userId) {
      const { rows } = await db.query('SELECT category FROM category_follows WHERE user_id = $1', [
        req.user.userId,
      ]);
      following = new Set(rows.map(row => row.category));
    }
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    res.json(counts.map(row => ({ ...row, following: following.has(row.category) })));
  })
);

/**
 * @openapi
 * /api/users/me/category-follows:
 *   get:
 *     tags: [Categories]
 *     summary: List the categories the current user follows
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Followed categories
 */
router.get(
  '/users/me/category-follows',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await listFollowedCategories(req.user.userId));
  })
);

/**
 * @openapi
 * /api/users/me/category-follows:
 *   post:
 *     tags: [Categories]
 *     summary: Follow a campaign category
 *     description: >
 *       Idempotent. Following an already-followed category returns 200 with
 *       `created: false` instead of an error, so retries and concurrent
 *       double-taps have deterministic behaviour.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category]
 *             properties:
 *               category:
 *                 type: string
 *                 enum: [technology, community, arts, education, environment, health, business, open_source, other]
 *     responses:
 *       201: { description: Category followed }
 *       200: { description: Already following (idempotent repeat) }
 *       400: { description: Invalid category }
 *       401: { description: Unauthorized }
 */
router.post(
  '/users/me/category-follows',
  requireAuth,
  categoryFollowLimiter,
  categoryBodyValidation,
  asyncHandler(async (req, res) => {
    if (validationError(req, res)) return;
    const category = normalizeCategory(req.body.category);
    let result;
    try {
      result = await followCategory(req.user.userId, category);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: err.message, fields: [] },
        });
      }
      throw err;
    }

    if (result.created) {
      logAuditEvent({
        actorId: req.user.userId,
        action: 'category_followed',
        resourceType: 'category_follow',
        resourceId: category,
        metadata: { category },
        req,
      }).catch(auditErr =>
        logger.warn('category follow audit failed', { error: auditErr.message })
      );
      return res.status(201).json(result);
    }
    return res.status(200).json(result);
  })
);

/**
 * @openapi
 * /api/users/me/category-follows/{category}:
 *   delete:
 *     tags: [Categories]
 *     summary: Unfollow a campaign category
 *     description: >
 *       Idempotent. Unfollowing a category that is not followed still returns
 *       204 so retries have deterministic behaviour. Scoped to the current
 *       user: users can only remove their own follows.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: category
 *         required: true
 *         schema:
 *           type: string
 *           enum: [technology, community, arts, education, environment, health, business, open_source, other]
 *     responses:
 *       204: { description: Unfollowed (or was not following) }
 *       400: { description: Invalid category }
 *       401: { description: Unauthorized }
 */
router.delete(
  '/users/me/category-follows/:category',
  requireAuth,
  categoryFollowLimiter,
  categoryParamValidation,
  asyncHandler(async (req, res) => {
    if (validationError(req, res)) return;
    const category = normalizeCategory(req.params.category);
    const removed = await unfollowCategory(req.user.userId, category);
    if (removed) {
      logAuditEvent({
        actorId: req.user.userId,
        action: 'category_unfollowed',
        resourceType: 'category_follow',
        resourceId: category,
        metadata: { category },
        req,
      }).catch(auditErr =>
        logger.warn('category unfollow audit failed', { error: auditErr.message })
      );
    }
    res.status(204).send();
  })
);

module.exports = router;
