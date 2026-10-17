const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  announcementIdValidation,
  createAnnouncementValidation,
  validateRequest,
} = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');

/**
 * @openapi
 * components:
 *   schemas:
 *     Announcement:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         message:
 *           type: string
 *         severity:
 *           type: string
 *           enum: [info, warning, critical]
 *         details_url:
 *           type: string
 *           nullable: true
 *         active_from:
 *           type: string
 *           format: date-time
 *         active_until:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         deactivated_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         created_by:
 *           type: string
 *           format: uuid
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 *       required:
 *         - id
 *         - message
 *         - severity
 *         - active_from
 *         - created_by
 *         - created_at
 *         - updated_at
 *     AnnouncementCreateRequest:
 *       type: object
 *       required:
 *         - message
 *       properties:
 *         message:
 *           type: string
 *         severity:
 *           type: string
 *           enum: [info, warning, critical]
 *           default: info
 *         details_url:
 *           type: string
 *           format: uri
 *           nullable: true
 *         active_from:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         active_until:
 *           type: string
 *           format: date-time
 *           nullable: true
 */

/**
 * @openapi
 * /api/announcements/active:
 *   get:
 *     tags: [Announcements]
 *     summary: List active platform announcements
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Announcement'
 */
router.get('/announcements/active', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT *
      FROM platform_announcements
      WHERE active_from <= NOW()
        AND deactivated_at IS NULL
        AND (
          active_until IS NULL
          OR active_until > NOW()
        )
      ORDER BY active_from DESC
    `);

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/announcements/create:
 *   post:
 *     tags: [Announcements]
 *     summary: Create a platform announcement
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AnnouncementCreateRequest'
 *     responses:
 *       201:
 *         description: Announcement created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Announcement'
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 */

router.post(
  '/announcements/create',
  requireAuth,
  requireRole('admin'),
  createAnnouncementValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { message, severity, details_url, active_from, active_until } = req.body;
    const createdBy = req.user.userId || req.user.id;

    const { rows } = await db.query(
      `
        INSERT INTO platform_announcements (
            message,
            severity,
            details_url,
            active_from,
            active_until,
            created_by
        )
        VALUES ($1, COALESCE($2, 'info'), $3, COALESCE($4, NOW()), $5, $6)
        RETURNING *;
        `,
      [message, severity, details_url, active_from, active_until, createdBy]
    );

    res.status(201).json(rows[0]);
  })
);

/**
 * @openapi
 * /api/announcements/{id}/deactivate:
 *   patch:
 *     tags: [Announcements]
 *     summary: Deactivate a platform announcement
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Announcement deactivated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Announcement'
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Announcement not found or already deactivated
 */
router.patch(
  '/announcements/:id/deactivate',
  requireAuth,
  requireRole('admin'),
  announcementIdValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `
      UPDATE platform_announcements
      SET
        deactivated_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND deactivated_at IS NULL
      RETURNING *;
      `,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Announcement not found or already deactivated',
      });
    }

    res.json(rows[0]);
  })
);

module.exports = router;
