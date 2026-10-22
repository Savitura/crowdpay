const { StrKey } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const totpService = require('../services/totpService');
const {
  STEP_UP_HEADER,
  PAYOUT_DESTINATION_PURPOSE,
  verifyStepUpToken,
} = require('../services/stepUpService');

const REJECTION_RESPONSES = {
  missing: {
    code: 'STEP_UP_REQUIRED',
    error: 'Re-authenticate to send payouts to this destination',
  },
  expired: {
    code: 'STEP_UP_EXPIRED',
    error: 'Your re-authentication has expired. Please confirm your identity again',
  },
  invalid: {
    code: 'STEP_UP_INVALID',
    error: 'Step-up token is invalid',
  },
  mismatch: {
    code: 'STEP_UP_INVALID',
    error: 'Step-up token was not issued for this account and destination',
  },
  impersonation: {
    code: 'STEP_UP_REQUIRED',
    error: 'Payout destinations cannot be changed while impersonating a user',
  },
};

async function auditStepUp(userId, eventType, req, metadata) {
  try {
    await totpService.logAuditEvent(userId, eventType, req, metadata);
  } catch (err) {
    logger.error('Failed to record step-up audit event', {
      error: err.message,
      eventType,
      userId,
    });
  }
}

/**
 * Requires a fresh step-up token (POST /api/auth/step-up) before a request may
 * direct funds to a Stellar destination other than the caller's own account
 * wallet. The token is bound to the user, the purpose, and the exact
 * destination, so it cannot be replayed for a different payout address.
 */
function requirePayoutDestinationStepUp({
  getDestination = req => req.body?.destination_key,
  action = 'payout_destination_change',
} = {}) {
  return async (req, res, next) => {
    try {
      const rawDestination = getDestination(req);
      const destinationKey = typeof rawDestination === 'string' ? rawDestination : '';

      // Missing/malformed destinations are rejected by the route's own
      // validation with a 400; prompting for step-up first would be misleading.
      if (!destinationKey || !StrKey.isValidEd25519PublicKey(destinationKey)) {
        return next();
      }

      const userId = req.user?.userId;
      const reject = reason => {
        const body = { ...REJECTION_RESPONSES[reason], purpose: PAYOUT_DESTINATION_PURPOSE };
        logger.warn('Payout destination change blocked pending step-up', {
          event: 'step_up_rejected',
          userId,
          action,
          reason,
        });
        auditStepUp(userId, 'step_up_rejected', req, {
          purpose: PAYOUT_DESTINATION_PURPOSE,
          action,
          reason,
          destination_key: destinationKey,
        });
        return res.status(403).json(body);
      };

      if (req.auth?.impersonated || req.impersonation) {
        return reject('impersonation');
      }

      const { rows } = await db.query('SELECT wallet_public_key FROM users WHERE id = $1', [
        userId,
      ]);
      if (rows[0]?.wallet_public_key && rows[0].wallet_public_key === destinationKey) {
        return next();
      }

      const token = req.get(STEP_UP_HEADER);
      if (!token) return reject('missing');

      const result = verifyStepUpToken(token, {
        userId,
        purpose: PAYOUT_DESTINATION_PURPOSE,
        destinationKey,
      });
      if (!result.valid) return reject(result.reason);

      req.stepUp = {
        purpose: PAYOUT_DESTINATION_PURPOSE,
        tokenId: result.payload.jti,
        verifiedAt: new Date(result.payload.iat * 1000).toISOString(),
      };
      await auditStepUp(userId, 'step_up_consumed', req, {
        purpose: PAYOUT_DESTINATION_PURPOSE,
        action,
        destination_key: destinationKey,
        token_id: result.payload.jti,
      });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  requirePayoutDestinationStepUp,
  REJECTION_RESPONSES,
};
