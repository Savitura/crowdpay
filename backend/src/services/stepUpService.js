const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const STEP_UP_HEADER = 'x-step-up-token';
const STEP_UP_AUDIENCE = 'crowdpay-step-up';
const PAYOUT_DESTINATION_PURPOSE = 'payout_destination';
const STEP_UP_PURPOSES = new Set([PAYOUT_DESTINATION_PURPOSE]);

const DEFAULT_STEP_UP_TTL_SECONDS = 300;
const MIN_STEP_UP_TTL_SECONDS = 30;
const MAX_STEP_UP_TTL_SECONDS = 900;

function getIssuer() {
  return process.env.JWT_ISSUER || 'https://crowdpay.io';
}

function getStepUpTtlSeconds() {
  const parsed = parseInt(process.env.STEP_UP_TTL_SECONDS, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_STEP_UP_TTL_SECONDS;
  return Math.min(Math.max(parsed, MIN_STEP_UP_TTL_SECONDS), MAX_STEP_UP_TTL_SECONDS);
}

// Derived key so a step-up token can never verify as an access token (or vice
// versa) even if audience checks were bypassed.
function getSigningKey() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('crowdpay-step-up-v1').digest();
}

function issueStepUpToken({ userId, purpose, destinationKey }) {
  if (!STEP_UP_PURPOSES.has(purpose)) throw new Error(`Unsupported step-up purpose: ${purpose}`);
  const ttlSeconds = getStepUpTtlSeconds();
  const token = jwt.sign({ purpose, destination_key: destinationKey }, getSigningKey(), {
    algorithm: 'HS256',
    subject: String(userId),
    audience: STEP_UP_AUDIENCE,
    issuer: getIssuer(),
    expiresIn: ttlSeconds,
    jwtid: crypto.randomUUID(),
  });
  return {
    token,
    expiresIn: ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

/**
 * @returns {{ valid: true, payload: object } | { valid: false, reason: 'expired'|'invalid'|'mismatch' }}
 */
function verifyStepUpToken(token, { userId, purpose, destinationKey }) {
  let payload;
  try {
    payload = jwt.verify(token, getSigningKey(), {
      algorithms: ['HS256'],
      audience: STEP_UP_AUDIENCE,
      issuer: getIssuer(),
    });
  } catch (err) {
    return { valid: false, reason: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }

  if (
    payload.sub !== String(userId) ||
    payload.purpose !== purpose ||
    payload.destination_key !== destinationKey
  ) {
    return { valid: false, reason: 'mismatch' };
  }
  return { valid: true, payload };
}

module.exports = {
  STEP_UP_HEADER,
  STEP_UP_AUDIENCE,
  PAYOUT_DESTINATION_PURPOSE,
  STEP_UP_PURPOSES,
  DEFAULT_STEP_UP_TTL_SECONDS,
  getStepUpTtlSeconds,
  issueStepUpToken,
  verifyStepUpToken,
};
