const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const {
  getLeaderboard,
  getUserRewards,
  getUserRewardSummary,
  getReferralAnalytics,
  getUserFraudChecks,
  resolveFraudCheck,
} = require('../services/referralService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * @openapi
 * /api/referrals/leaderboard:
 *   get:
 *     tags: [Referrals]
 *     summary: Get referral performance leaderboard
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of top referrers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       totalEarned: { type: number }
 *                       totalReferrals: { type: integer }
 *                       totalContributions: { type: integer }
 */
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const leaderboard = await getLeaderboard({ limit: Math.min(Number(limit), 100), offset: Math.max(Number(offset), 0) });
  res.json({ leaderboard });
}));

/**
 * @openapi
 * /api/referrals/rewards:
 *   get:
 *     tags: [Referrals]
 *     summary: Get rewards for authenticated user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [earned, paid_out, cancelled] }
 *     responses:
 *       200:
 *         description: List of user rewards
 */
router.get('/rewards', requireAuth, asyncHandler(async (req, res) => {
  const { rewards, total } = await getUserRewards(req.user.userId, {
    status: req.query.status,
  });
  res.json({ rewards, total });
}));

/**
 * @openapi
 * /api/referrals/rewards/summary:
 *   get:
 *     tags: [Referrals]
 *     summary: Get reward summary for authenticated user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Reward summary
 */
router.get('/rewards/summary', requireAuth, asyncHandler(async (req, res) => {
  const summary = await getUserRewardSummary(req.user.userId);
  res.json(summary);
}));

/**
 * @openapi
 * /api/referrals/analytics:
 *   get:
 *     tags: [Referrals]
 *     summary: Get referral analytics for authenticated user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Referral analytics
 */
router.get('/analytics', requireAuth, asyncHandler(async (req, res) => {
  const analytics = await getReferralAnalytics(req.user.userId);
  res.json(analytics);
}));

/**
 * @openapi
 * /api/referrals/fraud-checks:
 *   get:
 *     tags: [Referrals]
 *     summary: Get fraud checks for authenticated user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of fraud checks
 */
router.get('/fraud-checks', requireAuth, asyncHandler(async (req, res) => {
  const { checks, total } = await getUserFraudChecks(req.user.userId, {
    resolved: req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined,
  });
  res.json({ checks, total });
}));

/**
 * @openapi
 * /api/referrals/fraud-checks/{id}/resolve:
 *   post:
 *     tags: [Referrals]
 *     summary: Resolve a fraud check
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Fraud check resolved
 */
router.post('/fraud-checks/:id/resolve', requireAuth, asyncHandler(async (req, res) => {
  await resolveFraudCheck(req.params.id, req.user.userId);
  res.json({ ok: true });
}));

module.exports = router;