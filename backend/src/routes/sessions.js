const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const {
  listUserSessions,
  revokeUserSession,
  getUserLoginAlerts,
  acknowledgeLoginAlert,
  getUserLoginAttempts,
} = require('../services/sessionService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Data retention periods for session-related data.
 *
 * - Sessions: active sessions are listed while valid. Revoked or expired
 *   sessions are retained for 30 days after revocation/expiry for audit and
 *   support purposes, then permanently purged.
 * - Login alerts: retained for 90 days from creation, regardless of
 *   acknowledgement status, then purged.
 * - Login attempts: retained for 90 days from attempt time, then purged.
 *
 * Notes for operators:
 * - Purge jobs are expected to enforce these windows (see sessionService).
 * - Changing these values is a policy change; update this document and the
 *   privacy policy together.
 * - Retention applies to personal data (IP-derived location, device info);
 *   deletion on account closure is handled separately by the account service.
 */
const RETENTION = Object.freeze({
  sessionsAfterEndDays: 30,
  loginAlertsDays: 90,
  loginAttemptsDays: 90,
});

/**
 * @openapi
 * /api/auth/sessions:
 *   get:
 *     tags: [Users]
 *     summary: List active sessions for current user
 *     description: Returns currently active sessions only. Ended sessions are retained for 30 days for audit purposes and are not returned here.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of active sessions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       device: { type: string }
 *                       location: { type: string }
 *                       lastSeen: { type: string, format: date-time }
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await listUserSessions(req.user.userId);
    res.json({ sessions });
  })
);

/**
 * @openapi
 * /api/auth/sessions/{id}:
 *   delete:
 *     tags: [Users]
 *     summary: Revoke a specific session
 *     description: Revoked sessions are retained for 30 days after revocation, then purged.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Session revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       404:
 *         description: Session not found
 */
router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const revoked = await revokeUserSession(req.params.id, req.user.userId);
    if (!revoked) {
      return res.status(404).json({ error: 'Session not found or already revoked' });
    }
    res.json({ ok: true });
  })
);

/**
 * @openapi
 * /api/auth/login-alerts:
 *   get:
 *     tags: [Users]
 *     summary: List login alerts for current user
 *     description: Login alerts are retained for 90 days from creation, then purged.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: acknowledged
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: List of login alerts
 */
router.get(
  '/login-alerts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { alerts, total } = await getUserLoginAlerts(req.user.userId, {
      acknowledged:
        req.query.acknowledged === 'true'
          ? true
          : req.query.acknowledged === 'false'
            ? false
            : undefined,
    });
    res.json({ alerts, total });
  })
);

/**
 * @openapi
 * /api/auth/login-alerts/{id}/acknowledge:
 *   post:
 *     tags: [Users]
 *     summary: Acknowledge a login alert
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Alert acknowledged
 */
router.post(
  '/login-alerts/:id/acknowledge',
  requireAuth,
  asyncHandler(async (req, res) => {
    await acknowledgeLoginAlert(req.params.id, req.user.userId);
    res.json({ ok: true });
  })
);

/**
 * @openapi
 * /api/auth/login-attempts:
 *   get:
 *     tags: [Users]
 *     summary: List login attempts for current user
 *     description: Login attempts are retained for 90 days, then purged.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of login attempts
 */
router.get(
  '/login-attempts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { attempts, total } = await getUserLoginAttempts(req.user.userId);
    res.json({ attempts, total });
  })
);

module.exports = router;
module.exports.RETENTION = RETENTION;
