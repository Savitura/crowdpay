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
  forgotPasswordValidation,
  resetPasswordValidation,
  validateRequest,
  validateRequestAsError,
} = require('../middleware/validation');

/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: User registration and login
 */

const REFRESH_TOKEN_COOKIE_NAME = 'cp_refresh_token';
const REFRESH_TOKEN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_MESSAGE =
  'If that email exists, a password reset link has been sent.';

const isTest = process.env.NODE_ENV === 'test';
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTest ? 100000 : 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
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

router.post('/register', registerLimiter, registerValidation, validateRequest, async (req, res) => {
  /**
   * @openapi
   * /api/auth/register:
   *   post:
   *     tags: [Users]
   *     summary: Register a new user
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password, name]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string, minLength: 6 }
   *               name: { type: string }
   *               role: { type: string, enum: [contributor, creator] }
   *     responses:
   *       201:
   *         description: Created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [token, user]
   *               properties:
   *                 token: { type: string }
   *                 user:
   *                   type: object
   *                   properties:
   *                     id: { type: integer }
   *                     email: { type: string, format: email }
   *                     name: { type: string }
   *                     wallet_public_key: { type: string }
   *                     role: { type: string }
   *                     kyc_status: { type: string }
   *                     kyc_completed_at: { type: string, nullable: true }
   *                     kyc_required_for_campaigns: { type: boolean }
   *       409:
   *         description: Email already registered
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error: { type: string }
   * /api/users/register:
   *   post:
   *     tags: [Users]
   *     summary: Register a new user (alias of /api/auth/register)
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password, name]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string, minLength: 6 }
   *               name: { type: string }
   *               role: { type: string, enum: [contributor, creator] }
   *     responses:
   *       201: { description: Created }
   *       409: { description: Email already registered }
   */
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

router.post('/login', loginLimiter, loginValidation, validateRequest, async (req, res) => {
  /**
   * @openapi
   * /api/auth/login:
   *   post:
   *     tags: [Users]
   *     summary: Login
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [token, user]
   *               properties:
   *                 token: { type: string }
   *                 user:
   *                   type: object
   *                   properties:
   *                     id: { type: integer }
   *                     email: { type: string, format: email }
   *                     name: { type: string }
   *                     wallet_public_key: { type: string }
   *                     role: { type: string }
   *                     kyc_status: { type: string }
   *                     kyc_completed_at: { type: string, nullable: true }
   *                     kyc_required_for_campaigns: { type: boolean }
   *       401:
   *         description: Invalid credentials
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error: { type: string }
   * /api/users/login:
   *   post:
   *     tags: [Users]
   *     summary: Login (alias of /api/auth/login)
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200: { description: OK }
   *       401: { description: Invalid credentials }
   */
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

router.post(
  '/forgot-password',
  loginLimiter,
  forgotPasswordValidation,
  validateRequestAsError,
  async (req, res) => {
    const normalizedEmail = req.body.email.trim().toLowerCase();

    const { rows } = await db.query(
      'SELECT id, email FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    if (rows.length) {
      const user = rows[0];
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

      await db.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );
      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${getFrontendUrl()}/reset-password?token=${rawToken}`;
      sendEmail({
        to: user.email,
        subject: 'Reset your CrowdPay password',
        text: `You requested a password reset. Open this link within 1 hour to choose a new password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>You requested a password reset. <a href="${resetUrl}">Reset your password</a> within 1 hour.</p><p>If you did not request this, you can ignore this email.</p>`,
      });
    }

    res.json({ message: FORGOT_PASSWORD_MESSAGE });
  }
);

router.post(
  '/reset-password',
  loginLimiter,
  resetPasswordValidation,
  validateRequestAsError,
  async (req, res) => {
    const { token, password } = req.body;
    const tokenHash = hashToken(token);

    const { rows } = await db.query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(400).json({
        error: 'Invalid or expired reset link. Please request a new one.',
      });
    }

    const resetToken = rows[0];
    const passwordHash = await bcrypt.hash(password, 10);

    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      resetToken.user_id,
    ]);
    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [resetToken.id]
    );
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [resetToken.user_id]
    );

    res.json({ message: 'Password reset successfully' });
  }
);

module.exports = router;
