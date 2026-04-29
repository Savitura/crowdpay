const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { ensureCustodialAccountFundedAndTrusted } = require('../services/stellarService');
const { sendEmail } = require('../services/emailService');
const { requireAuth } = require('../middleware/auth');
const { encryptWalletSecret } = require('../services/walletSecrets');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const {
  registerValidation,
  loginValidation,
  validateRequest,
} = require('../middleware/validation');

const REFRESH_TOKEN_COOKIE_NAME = 'cp_refresh_token';
const REFRESH_TOKEN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateTokens(user) {
  const accessToken = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { accessToken, refreshToken };
}

function setRefreshTokenCookie(res, token, expiresAt) {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE,
    expires: expiresAt,
  });
}

function clearRefreshTokenCookie(res) {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    expires: new Date(0),
  });
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

function parseRefreshExpiresIn(value) {
  const match = value.match(/^(\d+)([dh])$/);
  if (!match) return 7 * 24 * 60 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return num * 60 * 60;
  return num * 24 * 60 * 60;
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
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
    [tokenHash]
  );
}

async function rotateRefreshToken(oldToken, userId) {
  await revokeRefreshToken(oldToken);
  return createRefreshToken(userId);
}

router.post('/register', authLimiter, registerValidation, validateRequest, async (req, res) => {
  const { email, password, name, role } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedName = String(name || '').trim();
  const allowedRoles = new Set(['contributor', 'creator']);
  const userRole = role || 'contributor';
  if (!allowedRoles.has(userRole)) {
    return res.status(400).json({ error: 'role must be contributor or creator' });
  }

  const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secret = keypair.secret();
  const encryptedSecret = await encryptWalletSecret(secret, { walletPublicKey: publicKey });

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at`,
    [normalizedEmail, passwordHash, normalizedName, publicKey, encryptedSecret, userRole]
  );

  const user = {
    ...rows[0],
    kyc_required_for_campaigns: isKycRequiredForCampaigns(),
  };
  const { accessToken } = generateTokens(user);
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

  setRefreshTokenCookie(res, refreshToken, expiresAt);

  const requestId = req.id;
  setImmediate(() => {
    ensureCustodialAccountFundedAndTrusted({ publicKey, secret }).catch((err) => {
      logger.error('Background Stellar funding/trustlines failed', {
        request_id: requestId,
        error: err.message,
      });
    });

    sendEmail({
      to: normalizedEmail,
      subject: 'Welcome to CrowdPay!',
      text: `Welcome ${normalizedName}! Your custodial wallet public key is ${publicKey}.`
    });
  });

  res.status(201).json({ token: accessToken, user });
});

router.post('/login', authLimiter, loginValidation, validateRequest, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = rows[0];
  const { accessToken } = generateTokens(user);
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

  setRefreshTokenCookie(res, refreshToken, expiresAt);

  res.json({
    token: accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      wallet_public_key: user.wallet_public_key,
      role: user.role,
      kyc_status: user.kyc_status,
      kyc_completed_at: user.kyc_completed_at,
      kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    },
  });
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'No refresh token provided' });
  }

  const user = await validateRefreshToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const { accessToken } = generateTokens(user);
  const { token: newRefreshToken, expiresAt } = await rotateRefreshToken(token, user.id);

  setRefreshTokenCookie(res, newRefreshToken, expiresAt);

  res.json({
    token: accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      wallet_public_key: user.wallet_public_key,
      role: user.role,
      kyc_status: user.kyc_status,
      kyc_completed_at: user.kyc_completed_at,
      kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    },
  });
});

router.post('/logout', requireAuth, async (req, res) => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  if (token) {
    await revokeRefreshToken(token);
  }
  clearRefreshTokenCookie(res);
  res.json({ message: 'Logged out successfully' });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  res.json({ message: 'If that email exists, a password reset link has been sent.' });
});

module.exports = router;
