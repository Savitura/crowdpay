'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

/**
 * @openapi
 * components:
 *   schemas:
 *     FeatureFlag:
 *       type: object
 *       properties:
 *         key:
 *           type: string
 *         enabled:
 *           type: boolean
 *         default_enabled:
 *           type: boolean
 *         description:
 *           type: string
 *           nullable: true
 *         updated_at:
 *           type: string
 *           format: date-time
 *       required:
 *         - key
 *         - enabled
 *         - default_enabled
 *         - updated_at
 *     FeatureFlagToggleRequest:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *       required:
 *         - enabled
 */

/**
 * @openapi
 * /api/feature-flags:
 *   get:
 *     tags: [Feature Flags]
 *     summary: List all feature flags (public, only key + enabled)
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FeatureFlag'
 */
router.get('/feature-flags', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT key, enabled, default_enabled, description, updated_at
    FROM feature_flags
    ORDER BY key
  `);
  res.json(rows);
}));

/**
 * @openapi
 * /api/feature-flags/enabled:
 *   get:
 *     tags: [Feature Flags]
 *     summary: List only enabled feature flags (public)
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 */
router.get('/feature-flags/enabled', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT key
    FROM feature_flags
    WHERE enabled = true
    ORDER BY key
  `);
  res.json(rows.map(r => r.key));
}));

/**
 * @openapi
 * /api/admin/feature-flags:
 *   get:
 *     tags: [Admin — Feature Flags]
 *     summary: List all feature flags with full details (admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FeatureFlag'
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 */
router.get('/admin/feature-flags', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT key, enabled, default_enabled, description, updated_at
    FROM feature_flags
    ORDER BY key
  `);
  res.json(rows);
}));

/**
 * @openapi
 * /api/admin/feature-flags/{key}:
 *   put:
 *     tags: [Admin — Feature Flags]
 *     summary: Toggle a feature flag (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/FeatureFlagToggleRequest'
 *     responses:
 *       200:
 *         description: Flag updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FeatureFlag'
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Flag not found
 */
router.put('/admin/feature-flags/:key', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  const { rows } = await db.query(`
    UPDATE feature_flags
    SET enabled = $1, updated_at = NOW()
    WHERE key = $2
    RETURNING key, enabled, default_enabled, description, updated_at
  `, [enabled, key]);

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Feature flag not found' });
  }

  res.json(rows[0]);
}));

module.exports = router;
