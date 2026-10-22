process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { verifyStepUpToken } = require('../services/stepUpService');

const DESTINATION = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';

const baseUser = {
  id: 'creator-1',
  email: 'creator@example.com',
  role: 'creator',
  password_hash: 'hashed-password',
  wallet_public_key: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  totp_enabled: false,
  totp_secret: null,
  backup_codes: null,
  totp_failed_attempts: 0,
  totp_locked_until: null,
};

const totpUser = {
  ...baseUser,
  totp_enabled: true,
  totp_secret: 'JBSWY3DPEHPK3PXP',
  backup_codes: ['hashed1', 'hashed2'],
};

function buildApp({
  user = baseUser,
  passwordValid = true,
  totpValid = true,
  backupValid = false,
  auth = { kind: 'jwt' },
} = {}) {
  const queries = [];
  const events = [];
  const removedBackupCodes = [];

  const router = proxyquire('./auth', {
    '../config/database': {
      query: async (text, params) => {
        queries.push({ text, params });
        if (text.includes('SELECT * FROM users WHERE id')) {
          return { rows: user ? [user] : [] };
        }
        return { rows: [] };
      },
    },
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
    '../services/walletSecrets': {
      encryptWalletSecret: async secret => `cpws:v1:${secret.slice(0, 8)}`,
    },
    '../services/emailService': {
      sendEmail: () => {},
      sendWelcomeEmail: async () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: baseUser.id, role: 'creator' };
        req.auth = auth;
        next();
      },
    },
    '../services/totpService': {
      verifyTotp: () => totpValid,
      verifyBackupCode: async () => ({ valid: backupValid, index: backupValid ? 0 : -1 }),
      removeBackupCode: async (_userId, _codes, index) => {
        removedBackupCodes.push(index);
      },
      logAuditEvent: async (userId, eventType, _req, metadata) => {
        events.push({ userId, eventType, metadata });
      },
    },
    bcryptjs: {
      hash: async () => 'hashed',
      compare: async () => passwordValid,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return { app, queries, events, removedBackupCodes };
}

test('POST /api/auth/step-up issues a destination-bound token after password re-entry', async () => {
  const { app, events } = buildApp();
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', destination_key: DESTINATION });

  assert.equal(res.status, 200);
  assert.equal(res.body.purpose, 'payout_destination');
  assert.equal(res.body.destination_key, DESTINATION);
  assert.equal(res.body.expires_in, 300);
  assert.equal(res.body.header, 'X-Step-Up-Token');

  const verified = verifyStepUpToken(res.body.step_up_token, {
    userId: baseUser.id,
    purpose: 'payout_destination',
    destinationKey: DESTINATION,
  });
  assert.equal(verified.valid, true);
  assert.equal(events.at(-1).eventType, 'step_up_succeeded');
  assert.equal(events.at(-1).metadata.method, 'password');
});

test('POST /api/auth/step-up rejects an incorrect password', async () => {
  const { app, events } = buildApp({ passwordValid: false });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'wrong', destination_key: DESTINATION });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'STEP_UP_FAILED');
  assert.equal(res.body.step_up_token, undefined);
  assert.equal(events.at(-1).eventType, 'step_up_failed');
  assert.equal(events.at(-1).metadata.reason, 'invalid_password');
});

test('POST /api/auth/step-up validates required fields', async () => {
  const { app } = buildApp();

  const noPassword = await request(app)
    .post('/api/auth/step-up')
    .send({ destination_key: DESTINATION });
  assert.equal(noPassword.status, 400);

  const badDestination = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', destination_key: 'not-a-key' });
  assert.equal(badDestination.status, 400);

  const badPurpose = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', destination_key: DESTINATION, purpose: 'account_delete' });
  assert.equal(badPurpose.status, 400);
});

test('POST /api/auth/step-up requires a 2FA code when TOTP is enabled', async () => {
  const { app } = buildApp({ user: totpUser });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', destination_key: DESTINATION });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'STEP_UP_TOTP_REQUIRED');
});

test('POST /api/auth/step-up accepts password plus a valid TOTP code and resets failures', async () => {
  const { app, queries, events } = buildApp({
    user: { ...totpUser, totp_failed_attempts: 3 },
  });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', code: '123456', destination_key: DESTINATION });

  assert.equal(res.status, 200);
  assert.ok(res.body.step_up_token);
  assert.ok(
    queries.some(q =>
      q.text.includes('UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL')
    )
  );
  assert.equal(events.at(-1).metadata.method, 'password+totp');
});

test('POST /api/auth/step-up accepts and consumes a backup code', async () => {
  const { app, removedBackupCodes } = buildApp({
    user: totpUser,
    backupValid: true,
  });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', code: 'abcd1234', destination_key: DESTINATION });

  assert.equal(res.status, 200);
  assert.deepEqual(removedBackupCodes, [0]);
});

test('POST /api/auth/step-up rejects a wrong 2FA code and counts the failure', async () => {
  const { app, queries, events } = buildApp({ user: totpUser, totpValid: false });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', code: '000000', destination_key: DESTINATION });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'STEP_UP_FAILED');
  const update = queries.find(q => q.text.includes('UPDATE users SET totp_failed_attempts = $1'));
  assert.ok(update);
  assert.equal(update.params[0], 1);
  assert.equal(update.params[1], null);
  assert.equal(events.at(-1).metadata.reason, 'invalid_2fa_code');
});

test('POST /api/auth/step-up locks the account after repeated 2FA failures', async () => {
  const { app, queries } = buildApp({
    user: { ...totpUser, totp_failed_attempts: 9 },
    totpValid: false,
  });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', code: '000000', destination_key: DESTINATION });

  assert.equal(res.status, 401);
  const update = queries.find(q => q.text.includes('UPDATE users SET totp_failed_attempts = $1'));
  assert.equal(update.params[0], 0);
  assert.ok(update.params[1] instanceof Date);
  assert.ok(update.params[1] > new Date());
});

test('POST /api/auth/step-up refuses locked accounts without checking credentials', async () => {
  const { app, events } = buildApp({
    user: { ...totpUser, totp_locked_until: new Date(Date.now() + 60_000) },
  });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', code: '123456', destination_key: DESTINATION });

  assert.equal(res.status, 423);
  assert.equal(res.body.code, 'STEP_UP_LOCKED');
  assert.equal(events.at(-1).metadata.reason, 'locked');
});

test('POST /api/auth/step-up is unavailable to impersonated sessions', async () => {
  const { app, queries } = buildApp({ auth: { kind: 'jwt', impersonated: true } });
  const res = await request(app)
    .post('/api/auth/step-up')
    .send({ password: 'correct', destination_key: DESTINATION });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'STEP_UP_FORBIDDEN');
  assert.equal(queries.length, 0);
});
