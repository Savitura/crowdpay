const router = require('express').Router();
const multer = require('multer');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { MILESTONE_LIMIT, MILESTONE_EVIDENCE_MAX_FILE_SIZE } = require('../config/constants');
const { requireAuth } = require('../middleware/auth');
const { sendAlert } = require('../services/alerting');
const {
  buildWithdrawalTransaction,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
} = require('../services/stellarService');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
} = require('../services/stellarTransactionService');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const {
  assertCustodialWithdrawalAllowed,
  CustodialSigningLimitError,
} = require('../services/custodialSigningPolicy');
const { resolveUserCampaignRole } = require('../services/campaignInviteService');
const { canSubmitMilestones } = require('../lib/campaignPermissions');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { invokeContract, nativeToScVal, releaseMilestone } = require('../services/sorobanService');
const {
  uploadMilestoneEvidence,
  parseMilestoneEvidenceUrl,
  milestoneEvidenceExists,
} = require('../services/storage');
const { createNotification } = require('../services/notifications');
const { notifyFollowers } = require('../services/campaignFollowService');
const { notifyContributorFundRelease } = require('../services/fundReleaseNotifications');
const { evaluateCampaign } = require('../services/fraudService');
const {
  sendMilestoneReleasedCreatorEmail,
  sendMilestoneEvidenceSubmittedAdminEmail,
} = require('../services/emailService');
const ledger = require('../services/milestoneLedger');
const {
  toReleaseAmount,
  logWithdrawalEvent,
  votesBlockRelease,
  setCampaignStatusFromMilestoneProgress,
} = ledger;
const autoRelease = require('../services/milestoneAutoRelease');
const { logAuditEvent } = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { validateRenderUrl } = require('../utils/urlValidation');
const crypto = require('crypto');
const createMilestonesService = require('../services/milestonesService');

const service = createMilestonesService({
  Keypair,
  db,
  logger,
  MILESTONE_LIMIT,
  sendAlert,
  buildWithdrawalTransaction,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
  withDecryptedWalletSecret,
  assertCustodialWithdrawalAllowed,
  CustodialSigningLimitError,
  resolveUserCampaignRole,
  canSubmitMilestones,
  emitWebhookEventForUser,
  WEBHOOK_EVENTS,
  invokeContract,
  nativeToScVal,
  releaseMilestone,
  uploadMilestoneEvidence,
  parseMilestoneEvidenceUrl,
  milestoneEvidenceExists,
  createNotification,
  notifyFollowers,
  notifyContributorFundRelease,
  evaluateCampaign,
  sendMilestoneReleasedCreatorEmail,
  sendMilestoneEvidenceSubmittedAdminEmail,
  ledger,
  toReleaseAmount,
  logWithdrawalEvent,
  votesBlockRelease,
  setCampaignStatusFromMilestoneProgress,
  autoRelease,
  logAuditEvent,
  validateRenderUrl,
  crypto,
});

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MILESTONE_EVIDENCE_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Upload an image, PDF, or document.'));
    }
    cb(null, true);
  },
});

router.get('/campaign/:campaignId', asyncHandler(service.listCampaignMilestones));
router.post('/', requireAuth, asyncHandler(service.createMilestone));
router.post('/:id/submit', requireAuth, asyncHandler(service.submitEvidence));
router.post(
  '/:id/upload-evidence',
  requireAuth,
  evidenceUpload.single('evidence_file'),
  service.uploadEvidence
);
router.get('/:id/auto-release', asyncHandler(service.getAutoRelease));
router.put('/:id/auto-release', requireAuth, asyncHandler(service.configureAutoRelease));
router.get('/:id/events', requireAuth, asyncHandler(service.getEvents));
router.get('/:id/votes', requireAuth, asyncHandler(service.getVotes));
router.post('/:id/votes', requireAuth, asyncHandler(service.castVote));
router.post('/:id/reject', requireAuth, asyncHandler(service.rejectMilestone));
router.post('/:id/approve', requireAuth, asyncHandler(service.approveMilestoneReleaseHandler));
router.post('/:id/release', requireAuth, asyncHandler(service.approveMilestoneReleaseHandler));

module.exports = router;
