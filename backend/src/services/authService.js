const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const logger = require('../config/logger');
const totpService = require('./totpService');
const { Keypair } = require('@stellar/stellar-sdk');
const { ensureCustodialAccountFundedAndTrusted } = require('./stellarService');
const { sendWelcomeEmail, sendWalletFundingFailedEmail, sendEmail } = require('./emailService');
const { encryptWalletSecret, withDecryptedTotpSecret } = require('./walletSecrets');
const { isKycRequiredForCampaigns } = require('./kycProvider');
const { createUserSession, recordLoginAttempt, checkLoginAnomalies } = require('./sessionService');

const ACCESS_TOKEN_COOKIE_NAME = 'cp_token';
const REFRESH_TOKEN_COOKIE_NAME = 'cp_refresh_token';
const REFRESH_TOKEN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_MESSAGE = 'If that email exists, a password reset link has been sent.';

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseJwtExpiresIn(value) {
  const match = String(value).match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return num;
  if (unit === 'm') return num * 60;
  if (unit === 'h') return num * 60 * 60;
  if (unit === 'd') return num * 24 * 60 * 60;
  return 15 * 60;
}

function parseRefreshExpiresIn(value) {
  const match = String(value || '7d').match(/^(\d+)([dh])$/);
  if (!match) return 7 * 24 * 60 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return num * 60 * 60;
  return num * 24 * 60 * 60;
}

function generateTokens(user) {
  const accessToken = jwt.sign(
    {
      sub: user.id.toString(),
      iss: 'https://crowdpay.io',
      aud: 'crowdpay-api',
      userId: user.id,
      email: user.email,
      is_admin: user.is_admin,
      role: user.role,
    },
    process.env.JWT_SECRET || 'testsecret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { accessToken, refreshToken };
}

async function verifyUserTotp(user, code) {
  return withDecryptedTotpSecret(user.totp_secret, user.id, secret =>
    totpService.verifyTotp(secret, code)
  );
}

async function createRefreshToken(userId) {
  const expiresInSeconds = parseRefreshExpiresIn(process.env.REFRESH_TOKEN_EXPIRES_IN || '7d');
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
  return { token, expiresAt };
}

async function validateRefreshToken(token) {
  const tokenHash = hashToken(token);
  const { rows } = await db.query(
    `SELECT rt.id, rt.user_id, u.id AS id, u.email, u.name, u.role, u.wallet_public_key,
            u.kyc_status, u.kyc_completed_at
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
    [tokenHash]
  );
  if (!rows.length) return null;
  return rows[0];
}

async function revokeRefreshToken(token) {
  const tokenHash = hashToken(token);
  await db.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
}

async function rotateRefreshToken(oldToken, userId) {
  await revokeRefreshToken(oldToken);
  return createRefreshToken(userId);
}

/**
 * Register a new user with custodial or non-custodial wallet setup.
 */
async function registerUser({
  email,
  password,
  name,
  role = 'contributor',
  walletType = 'custodial',
  walletPublicKey = null,
  req = null,
}) {
  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();
  const normalizedName = String(name || '').trim();
  const allowedRoles = new Set(['contributor', 'creator']);
  const userRole = role || 'contributor';
  if (!allowedRoles.has(userRole)) {
    const err = new Error('role must be contributor or creator');
    err.status = 400;
    throw err;
  }

  const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [
    normalizedEmail,
  ]);
  if (existing.rows.length > 0) {
    const err = new Error('Email already registered');
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  let publicKey;
  let encryptedSecret = null;
  let secret = null;

  if (walletType === 'freighter') {
    publicKey = walletPublicKey;
  } else {
    const keypair = Keypair.random();
    publicKey = keypair.publicKey();
    secret = keypair.secret();
    encryptedSecret = await encryptWalletSecret(secret, { walletPublicKey: publicKey });
  }

  const walletFundedAt = walletType === 'freighter' ? new Date() : null;

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, role, wallet_type, wallet_funded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at, wallet_type, wallet_funded_at, wallet_funding_failed_at`,
    [
      normalizedEmail,
      passwordHash,
      normalizedName,
      publicKey,
      encryptedSecret,
      userRole,
      walletType,
      walletFundedAt,
    ]
  );

  const user = {
    ...rows[0],
    kyc_required_for_campaigns: isKycRequiredForCampaigns(),
  };

  const { accessToken } = generateTokens(user);
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

  const { rows: rtRows } = await db.query('SELECT id FROM refresh_tokens WHERE token_hash = $1', [
    hashToken(refreshToken),
  ]);
  const refreshTokenId = rtRows[0]?.id;

  if (refreshTokenId && req) {
    await createUserSession(user.id, refreshTokenId, req);
  }

  if (req) {
    await recordLoginAttempt({
      userId: user.id,
      email: normalizedEmail,
      ip: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : null,
      success: true,
    });
  }

  // Trigger background wallet funding and welcome email
  setImmediate(() => {
    if (walletType === 'custodial' && secret) {
      ensureCustodialAccountFundedAndTrusted({ publicKey, secret })
        .then(async () => {
          await db.query(
            'UPDATE users SET wallet_funded_at = NOW(), wallet_funding_failed_at = NULL WHERE id = $1',
            [user.id]
          );
          logger.info('Background Stellar funding/trustlines succeeded', { userId: user.id });
        })
        .catch(async err => {
          logger.error('Background Stellar funding/trustlines failed', {
            userId: user.id,
            error: err.message,
          });
          await db.query('UPDATE users SET wallet_funding_failed_at = NOW() WHERE id = $1', [
            user.id,
          ]);
          sendWalletFundingFailedEmail({
            to: normalizedEmail,
            name: normalizedName,
            walletPublicKey: publicKey,
          }).catch(emailErr => {
            logger.error('Failed to send wallet funding failed email', {
              userId: user.id,
              error: emailErr.message,
            });
          });
        });
    }

    sendWelcomeEmail({
      to: normalizedEmail,
      name: normalizedName,
      walletPublicKey: publicKey,
    }).catch(err => {
      logger.error('Welcome email failed', { error: err.message });
    });
  });

  return { user, accessToken, refreshToken, expiresAt };
}

/**
 * Authenticate a user by email and password.
 */
async function authenticateUser({ email, password, req = null }) {
  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();
  const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    if (req) {
      await recordLoginAttempt({
        email: normalizedEmail,
        ip: req.ip,
        userAgent: req.headers ? req.headers['user-agent'] : null,
        success: false,
        failureReason: 'Invalid credentials',
      });
    }
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }

  const user = rows[0];

  const enforceResult = await totpService.enforce2faCheck(user);
  if (enforceResult && enforceResult.enforced) {
    const err = new Error(enforceResult.message);
    err.status = 403;
    throw err;
  }

  if (user.totp_enabled) {
    const fingerprint = req ? totpService.generateFingerprint(req) : null;
    const trusted = fingerprint ? await totpService.isDeviceTrusted(user.id, fingerprint) : false;
    if (!trusted) {
      return { requires2fa: true, userId: user.id };
    }
  }

  const { accessToken } = generateTokens(user);
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

  const { rows: rtRows } = await db.query('SELECT id FROM refresh_tokens WHERE token_hash = $1', [
    hashToken(refreshToken),
  ]);
  const refreshTokenId = rtRows[0]?.id;

  if (refreshTokenId && req) {
    await createUserSession(user.id, refreshTokenId, req);
  }

  if (req) {
    await recordLoginAttempt({
      userId: user.id,
      email: normalizedEmail,
      ip: req.ip,
      userAgent: req.headers ? req.headers['user-agent'] : null,
      success: true,
    });
  }

  const sanitizedUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    wallet_public_key: user.wallet_public_key,
    role: user.role,
    kyc_status: user.kyc_status,
    kyc_completed_at: user.kyc_completed_at,
    kyc_required_for_campaigns: isKycRequiredForCampaigns(),
  };

  return { user: sanitizedUser, accessToken, refreshToken, expiresAt, requires2fa: false };
}

module.exports = {
  hashToken,
  parseJwtExpiresIn,
  parseRefreshExpiresIn,
  generateTokens,
  createRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyUserTotp,
  registerUser,
  authenticateUser,
  ACCESS_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_MAX_AGE,
};
