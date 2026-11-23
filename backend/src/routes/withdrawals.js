const router = require('express').Router();
/**
 * @openapi
 * tags:
 *   - name: Withdrawals
 *     description: Withdrawal requests and audit timeline
 */
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { createVelocityLimit } = require('../middleware/velocityLimit');
const { withdrawalValidation, validateRequest } = require('../middleware/validation');
const {
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  isXdrExpired,
  getPlatformPublicKey,
  validateSubmittedWithdrawalXdr,
  validateWithdrawalForPlatformSigning,
} = require('../services/stellarService');
const { calculateCreatorShare } = require('../services/feeRegistry');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
} = require('../services/stellarTransactionService');
const {
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
} = require('../services/emailService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const {
  assertCustodialWithdrawalAllowed,
  CustodialSigningLimitError,
} = require('../services/custodialSigningPolicy');
const { createNotification } = require('../services/notifications');
const { notifyContributorFundRelease } = require('../services/fundReleaseNotifications');
const { calculateCommissions, settleCommissions } = require('../services/referral');
const { parsePagination } = require('../utils/pagination');
const asyncHandler = require('../utils/asyncHandler');
const withTransaction = require('../utils/withTransaction');
const { toStroops, fromStroops } = require('../utils/stroops');
const { logAuditEvent } = require('../services/auditService');
const createWithdrawalsService = require('../services/withdrawalsService');

const service = createWithdrawalsService({
  db,
  logger,
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  isXdrExpired,
  getPlatformPublicKey,
  validateSubmittedWithdrawalXdr,
  validateWithdrawalForPlatformSigning,
  calculateCreatorShare,
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
  emitWebhookEventForUser,
  WEBHOOK_EVENTS,
  withDecryptedWalletSecret,
  assertCustodialWithdrawalAllowed,
  CustodialSigningLimitError,
  createNotification,
  notifyContributorFundRelease,
  calculateCommissions,
  settleCommissions,
  parsePagination,
  withTransaction,
  toStroops,
  fromStroops,
  logAuditEvent,
});

const withdrawalVelocityLimit = createVelocityLimit({
  kind: 'withdrawal',
  actorId: req => req.user?.userId,
  query: (text, params) => db.query(text, params),
});

async function requirePlatformApprover(req, res, next) {
  if (!service.canPerformPlatformSignature(req.user.userId)) {
    return res
      .status(403)
      .json({ error: 'Only the designated platform approver can perform this action' });
  }
  const { rows } = await db.query('SELECT role, is_admin FROM users WHERE id = $1', [
    req.user.userId,
  ]);
  if (!rows.length || (rows[0].role !== 'admin' && !rows[0].is_admin)) {
    return res.status(403).json({ error: 'Account no longer has platform authorization' });
  }
  next();
}

router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ can_approve_platform: service.canPerformPlatformSignature(req.user.userId) });
});
/**
 * @openapi
 * /api/withdrawals/request:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Create a pending withdrawal request
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [campaign_id, destination_key, amount]
 *             properties:
 *               campaign_id: { type: string }
 *               destination_key: { type: string }
 *               amount: { type: string }
 *     responses:
 *       201:
 *         description: Created
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Campaign not found
 *       429:
 *         description: Withdrawal velocity limit exceeded
 */
router.post(
  '/request',
  requireAuth,
  withdrawalValidation,
  validateRequest,
  withdrawalVelocityLimit,
  asyncHandler(service.requestWithdrawal)
);
router.post('/:id/approve/creator', requireAuth, asyncHandler(service.creatorApprove));
router.post(
  '/:id/approve/platform',
  requireAuth,
  requirePlatformApprover,
  idempotency('wallet:withdrawal-submit'),
  asyncHandler(service.platformApproveHandler)
);
router.post(
  '/:id/approve',
  requireAuth,
  requirePlatformApprover,
  idempotency('wallet:withdrawal-submit'),
  asyncHandler(service.platformApproveHandler)
);
router.post('/:id/cancel', requireAuth, asyncHandler(service.cancelWithdrawal));
/**
 * @openapi
 * /api/withdrawals/{id}/reject:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Platform rejection
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post(
  '/:id/reject',
  requireAuth,
  requirePlatformApprover,
  asyncHandler(service.rejectWithdrawal)
);
router.get('/campaign/:campaignId', requireAuth, asyncHandler(service.listCampaignWithdrawals));
router.get(
  '/campaign/:campaignId/contributor-history',
  requireAuth,
  asyncHandler(service.contributorHistory)
);
router.get('/:id', requireAuth, asyncHandler(service.getWithdrawal));
/**
 * @openapi
 * /api/withdrawals/{id}/audit:
 *   get:
 *     tags: [Withdrawals]
 *     summary: Withdrawal audit timeline (alias of /events)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Not found
 */
router.get('/:id/events', requireAuth, asyncHandler(service.withdrawalAuditHandler));
router.get('/:id/audit', requireAuth, asyncHandler(service.withdrawalAuditHandler));

module.exports = router;
