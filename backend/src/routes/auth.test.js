const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const cookieParser = require('cookie-parser');

// auth.js reads process.env.NODE_ENV once, at require time, to size its rate
// limiters. Force NODE_ENV to 'test' so the limiter `skip()` short-circuits and
// all assertions hold regardless of how this file is invoked. Restored after
// the suite so nothing leaks to a process that reuses this env.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
test.after(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const USER_ID = 1;
const PASSWORD = 'Password123!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const VALID_REFRESH_TOKEN = 'refreshtoken-valid';
const VALID_RESET_TOKEN = 'resettoken-valid';
const VALID_STELLAR_PUBLIC_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

const BASE_USER = {
  id: USER_ID,
  email: 'user@example.com',
  name: 'Test User',
  role: 'contributor',
  is_admin: false,
  wallet_public_key: 'GAAAATESTPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  wallet_type: 'custodial',
  wallet_funded_at: null,
  kyc_status: 'pending',
  kyc_completed_at: null,
  password_hash: PASSWORD_HASH,
  totp_enabled: false,
  totp_secret: 'TOTPSECRET',
  totp_failed_attempts: 0,
  totp_locked_until: null,
  backup_codes: null,
};

function buildApp({
  userRow = BASE_USER,
  userMissing = false,
  registerExisting = false,
  authError = null,
  totp = {},
  kyc = {},
  queryImplOverride,
} = {}) {
  const calls = {
    db: [],
    emails: [],
    sessions: [],
    loginAttempts: [],
    anomalies: [],
    totpAudit: [],
    totpOps: [],
    funded: [],
    encrypted: [],
  };

  const totpService = {
    enforce2faCheck: async () => totp.enforceResult || { enforced: false },
    generateFingerprint: (req) => `fp-${req.headers['user-agent'] || 'ua'}`,
    isDeviceTrusted: async () => Boolean(totp.deviceTrusted),
    verifyTotp: () => Boolean(totp.verifyTotpResult),
    verifyBackupCode: async () => ({ valid: Boolean(totp.backupValid), index: 0 }),
    removeBackupCode: async (userId, _codes, index) => {
      calls.totpOps.push(['removeBackupCode', userId, index]);
    },
    logAuditEvent: async (userId, event, _req, meta) => {
      calls.totpAudit.push({ userId, event, meta });
    },
    generateSecret: () => 'TESTSECRET',
    buildOtpauthUri: (email, secret) => `otpauth://totp/crowdpay:${email}?secret=${secret}`,
    generateQrCode: async () => 'data:image/png;base64,AAAA',
    generateBackupCodes: async () => ({
      raw: ['AAAA-AAAA', 'BBBB-BBBB'],
      hashed: ['h-aaaa', 'h-bbbb'],
    }),
    revokeAllDevices: async (userId) => {
      calls.totpOps.push(['revokeAllDevices', userId]);
    },
    trustDevice: async (userId, fingerprint, _req) => {
      calls.totpOps.push(['trustDevice', userId, fingerprint]);
    },
    getUserDevices: async (userId) => {
      calls.totpOps.push(['getUserDevices', userId]);
      return [{ id: 1, fingerprint: 'fp-x' }];
    },
    revokeDevice: async (userId, deviceId) => {
      calls.totpOps.push(['revokeDevice', userId, deviceId]);
      return totp.revokeDeviceResult !== undefined ? totp.revokeDeviceResult : { id: deviceId };
    },
    ...(totp.extra || {}),
  };

  const queryImpl = queryImplOverride
    ? async (sql, params) => {
        calls.db.push({ sql, params });
        return queryImplOverride(sql, params, calls);
      }
    : async (sql, params) => {
        calls.db.push({ sql, params });
        if (sql.includes('SELECT rt.id, rt.user_id, u.id AS id')) {
          if (params && params[0] === hashToken(VALID_REFRESH_TOKEN)) {
            return { rows: [{ ...userRow, id: USER_ID, user_id: USER_ID }] };
          }
          return { rows: [] };
        }
        if (sql.includes('SELECT prt.id, prt.user_id')) {
          if (params && params[0] === hashToken(VALID_RESET_TOKEN)) {
            return { rows: [{ id: 99, user_id: USER_ID }] };
          }
          return { rows: [] };
        }
        if (sql.includes('SELECT id FROM refresh_tokens WHERE token_hash')) {
          return { rows: [{ id: 100 }] };
        }
        if (sql.includes('SELECT id FROM users WHERE LOWER(email)')) {
          return { rows: registerExisting ? [{ id: 0 }] : [] };
        }
        if (sql.includes('SELECT id, email FROM users')) {
          return { rows: !userMissing && userRow ? [{ id: USER_ID, email: userRow.email }] : [] };
        }
        if (sql.includes('SELECT * FROM users WHERE id = $1')) {
          return { rows: userRow ? [userRow] : [] };
        }
        if (sql.includes('SELECT * FROM users WHERE LOWER(email)')) {
          return { rows: userMissing ? [] : userRow ? [userRow] : [] };
        }
        if (sql.includes('INSERT INTO users')) {
          return { rows: [userRow] };
        }
        return { rows: [] };
      };

  const router = proxyquire('./auth', {
    '../config/database': { query: queryImpl },
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    '../services/totpService': totpService,
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async (opts) => {
        calls.funded.push(opts);
      },
    },
    '../services/emailService': {
      sendEmail: async (opts) => {
        calls.emails.push(['sendEmail', opts]);
      },
      sendWelcomeEmail: async (opts) => {
        calls.emails.push(['sendWelcome', opts]);
      },
      sendWalletFundingFailedEmail: async (opts) => {
        calls.emails.push(['sendFundingFailed', opts]);
      },
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (authError) {
          return res.status(401).json({ error: authError });
        }
        req.user = { userId: USER_ID, role: 'user' };
        next();
      },
    },
    '../services/walletSecrets': {
      encryptWalletSecret: async (secret, opts) => {
        calls.encrypted.push({ secret, opts });
        return `ENC-${secret}`;
      },
    },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => Boolean(kyc.requiredForCampaigns),
    },
    '../services/kycService': {
      startKycForUser: async () => {
        if (kyc.startError) throw kyc.startError;
        return kyc.startResult || { status: 'pending', sessionUrl: 'https://persona/session' };
      },
      getKycStatusForUser: async () => {
        if (kyc.statusError) throw kyc.statusError;
        return kyc.statusResult || { status: 'pending' };
      },
    },
    '../services/sessionService': {
      createUserSession: async (userId, refreshTokenId, _req) => {
        calls.sessions.push([userId, refreshTokenId]);
      },
      recordLoginAttempt: async (opts) => {
        calls.loginAttempts.push(opts);
      },
      checkLoginAnomalies: async (userId, email, _req) => {
        calls.anomalies.push([userId, email]);
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', router);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || err.status || 500).json({ error: err.message });
  });

  return { app, calls };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// REGISTER
// ---------------------------------------------------------------------------

test('POST /api/auth/register registers a custodial user and issues tokens', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'User@Example.com', password: PASSWORD, name: 'Test User' });

  assert.equal(res.status, 201);
  assert.ok(res.body.token, 'access token issued');
  assert.equal(res.body.user.email, 'user@example.com');
  assert.equal(res.body.user.kyc_required_for_campaigns, false);
  assert.ok(
    res.headers['set-cookie'].some((c) => c.startsWith('cp_token=')),
    'sets access token cookie',
  );
  assert.ok(
    res.headers['set-cookie'].some((c) => c.startsWith('cp_refresh_token=')),
    'sets refresh token cookie',
  );

  const insert = calls.db.find((q) => q.sql.includes('INSERT INTO users'));
  assert.ok(insert, 'user inserted');
  assert.equal(insert.params[0], 'user@example.com');
  assert.ok(insert.params[1].startsWith('$2'), 'password is bcrypt-hashed');
  assert.equal(insert.params[2], 'Test User');
  assert.ok(String(insert.params[3]).startsWith('G'), 'wallet public key generated');
  assert.ok(String(insert.params[4]).startsWith('ENC-'), 'custodial secret encrypted');
  assert.equal(insert.params[5], 'contributor');
  assert.equal(insert.params[6], 'custodial');

  assert.equal(calls.encrypted.length, 1, 'secret encrypted for custodial wallet');
  assert.deepEqual(calls.sessions[0].slice(0, 2), [USER_ID, 100], 'user session created');
  assert.equal(calls.loginAttempts[0].success, true, 'successful login recorded');
  assert.equal(calls.loginAttempts[0].email, 'user@example.com');

  await flushAsync();
  assert.equal(calls.funded.length, 1, 'custodial wallet funded in background');
  assert.ok(
    calls.emails.some(([kind]) => kind === 'sendWelcome'),
    'welcome email sent',
  );
});

test('POST /api/auth/register rejects an invalid role', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'user@example.com', password: PASSWORD, name: 'T', role: 'superadmin' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/register rejects a duplicate email', async () => {
  const { app } = buildApp({ registerExisting: true });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'user@example.com', password: PASSWORD, name: 'Test User' });

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Email already registered' });
});

test('POST /api/auth/register rejects a weak password', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'user@example.com', password: 'short', name: 'T' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/register rejects an invalid email', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'nope', password: PASSWORD, name: 'T' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/register supports freighter (non-custodial) wallets', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({
      email: 'user@example.com',
      password: PASSWORD,
      name: 'Test User',
      wallet_type: 'freighter',
      wallet_public_key: VALID_STELLAR_PUBLIC_KEY,
    });

  assert.equal(res.status, 201);

  const insert = calls.db.find((q) => q.sql.includes('INSERT INTO users'));
  assert.equal(insert.params[4], null, 'no secret encrypted for freighter wallet');
  assert.equal(insert.params[6], 'freighter');
  assert.ok(insert.params[7] instanceof Date, 'freighter wallet marked funded');
  assert.equal(calls.encrypted.length, 0, 'no encryption for freighter wallet');

  await flushAsync();
  assert.equal(calls.funded.length, 0, 'no background funding for freighter wallet');
});

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------

test('POST /api/auth/login logs in with valid credentials', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: PASSWORD });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'user@example.com');
  assert.equal(res.body.user.role, 'contributor');
  assert.equal(res.body.user.kyc_required_for_campaigns, false);
  assert.ok(res.headers['set-cookie'].some((c) => c.startsWith('cp_token=')));
  assert.ok(res.headers['set-cookie'].some((c) => c.startsWith('cp_refresh_token=')));

  assert.equal(calls.sessions.length, 1, 'user session created');
  assert.equal(calls.anomalies.length, 1, 'login anomalies checked');
  const success = calls.loginAttempts.filter((a) => a.success);
  assert.equal(success.length, 1, 'successful login recorded');
});

test('POST /api/auth/login returns 401 for a wrong password', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'WrongPassword1' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
  assert.equal(calls.loginAttempts[0].success, false);
  assert.equal(calls.loginAttempts[0].failureReason, 'Invalid credentials');
  assert.equal(calls.sessions.length, 0, 'no session for failed login');
});

test('POST /api/auth/login returns 401 for an unknown email', async () => {
  const { app } = buildApp({ userMissing: true });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'ghost@example.com', password: PASSWORD });

  assert.equal(res.status, 401);
});

test('POST /api/auth/login returns 400 for an invalid email', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nope', password: PASSWORD });

  assert.equal(res.status, 400);
});

test('POST /api/auth/login returns 403 when 2FA is enforced', async () => {
  const { app } = buildApp({
    totp: { enforceResult: { enforced: true, message: '2FA is required for this account' } },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: PASSWORD });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: '2FA is required for this account' });
});

test('POST /api/auth/login asks for 2FA on an untrusted device', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { deviceTrusted: false },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: PASSWORD });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { requires_2fa: true });
  assert.ok(!res.headers['set-cookie'], 'no tokens issued before 2FA');
  assert.equal(calls.sessions.length, 0);
});

test('POST /api/auth/login skips 2FA on a trusted device', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { deviceTrusted: true },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: PASSWORD });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(calls.sessions.length, 1);
});

// ---------------------------------------------------------------------------
// 2FA CHALLENGE
// ---------------------------------------------------------------------------

test('POST /api/auth/2fa/challenge requires email, password, and code', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/2fa/challenge').send({ email: 'x' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Email, password, and code are required' });
});

test('POST /api/auth/2fa/challenge rejects invalid credentials', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: 'Wrong1', code: '123456' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
});

test('POST /api/auth/2fa/challenge rejects accounts without 2FA', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: '123456' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: '2FA is not enabled for this account' });
});

test('POST /api/auth/2fa/challenge blocks locked accounts', async () => {
  const { app } = buildApp({
    userRow: {
      ...BASE_USER,
      totp_enabled: true,
      totp_locked_until: new Date(Date.now() + 60 * 1000).toISOString(),
    },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: '123456' });

  assert.equal(res.status, 423);
  assert.deepEqual(res.body, { error: 'Too many failed 2FA attempts. Try again later.' });
});

test('POST /api/auth/2fa/challenge accepts a valid TOTP code', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { verifyTotpResult: true },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: '123456' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.device_trusted, false);
  assert.equal(res.body.user.email, 'user@example.com');
  assert.ok(res.headers['set-cookie'].some((c) => c.startsWith('cp_token=')));
  assert.ok(calls.totpAudit.some((a) => a.event === 'totp_challenge_success'));
});

test('POST /api/auth/2fa/challenge records a failed attempt', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { verifyTotpResult: false },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: '123456' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid 2FA code' });

  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET totp_failed_attempts'));
  assert.equal(update.params[0], 1, 'consecutive failure counter incremented');
  assert.equal(update.params[1], null, 'not locked out yet');
  assert.equal(update.params[2], USER_ID);
  assert.ok(calls.totpAudit.some((a) => a.event === 'totp_challenge_failed'));
});

test('POST /api/auth/2fa/challenge locks the account after 10 consecutive failures', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true, totp_failed_attempts: 9 },
    totp: { verifyTotpResult: false },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: '123456' });

  assert.equal(res.status, 401);

  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET totp_failed_attempts'));
  assert.equal(update.params[0], 0, 'counter reset on lockout');
  assert.ok(update.params[1] instanceof Date, 'lockout timestamp set');
});

test('POST /api/auth/2fa/challenge resets the counter after a success', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true, totp_failed_attempts: 3 },
    totp: { verifyTotpResult: true },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: '123456' });

  assert.equal(res.status, 200);
  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET totp_failed_attempts = 0'));
  assert.ok(update, 'failed counter cleared after success');
});

test('POST /api/auth/2fa/challenge accepts a backup code', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true, backup_codes: ['h-aaaa'] },
    totp: { backupValid: true },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'user@example.com', password: PASSWORD, code: 'AAAA-AAAA' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.ok(calls.totpOps.some(([op]) => op === 'removeBackupCode'), 'backup code consumed');
  assert.ok(calls.totpAudit.some((a) => a.event === 'totp_challenge_success'));
});

// ---------------------------------------------------------------------------
// 2FA SETUP / VERIFY / DISABLE / CODES / DEVICES / AUDIT
// ---------------------------------------------------------------------------

test('POST /api/auth/2fa/setup is restricted to creators and admins', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/2fa/setup');

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, {
    error: '2FA is only available for creator and admin accounts',
  });
});

test('POST /api/auth/2fa/setup rejects when 2FA is already enabled', async () => {
  const { app } = buildApp({ userRow: { ...BASE_USER, role: 'creator', totp_enabled: true } });

  const res = await request(app).post('/api/auth/2fa/setup');

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: '2FA is already enabled' });
});

test('POST /api/auth/2fa/setup generates a secret for a creator', async () => {
  const { app, calls } = buildApp({ userRow: { ...BASE_USER, role: 'creator' } });

  const res = await request(app).post('/api/auth/2fa/setup');

  assert.equal(res.status, 200);
  assert.equal(res.body.secret, 'TESTSECRET');
  assert.ok(res.body.qrCodeDataUrl.startsWith('data:image/png'));
  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET totp_secret'));
  assert.equal(update.params[0], 'TESTSECRET');
  assert.ok(calls.totpAudit.some((a) => a.event === 'totp_setup_initiated'));
});

test('POST /api/auth/2fa/setup returns 401 without auth', async () => {
  const { app } = buildApp({ authError: 'Missing token' });

  const res = await request(app).post('/api/auth/2fa/setup');

  assert.equal(res.status, 401);
});

test('POST /api/auth/2fa/verify requires a code', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/2fa/verify').send({});

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Code is required' });
});

test('POST /api/auth/2fa/verify rejects when setup was not initiated', async () => {
  const { app } = buildApp({ userRow: { ...BASE_USER, totp_secret: null } });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '123456' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: '2FA setup not initiated' });
});

test('POST /api/auth/2fa/verify rejects an invalid code', async () => {
  const { app } = buildApp({ totp: { verifyTotpResult: false } });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '999999' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid 2FA code' });
});

test('POST /api/auth/2fa/verify enables 2FA and returns backup codes', async () => {
  const { app, calls } = buildApp({ totp: { verifyTotpResult: true } });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '123456' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, '2FA enabled successfully');
  assert.deepEqual(res.body.backupCodes, ['AAAA-AAAA', 'BBBB-BBBB']);
  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET totp_enabled = true'));
  assert.deepEqual(update.params[0], ['h-aaaa', 'h-bbbb'], 'hashed backup codes stored');
  assert.ok(calls.totpAudit.some((a) => a.event === 'totp_enabled'));
});

test('POST /api/auth/2fa/disable requires a code', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/2fa/disable').send({});

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Current 2FA code is required to disable' });
});

test('POST /api/auth/2fa/disable rejects when not enabled', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/2fa/disable').send({ code: '123456' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: '2FA is not enabled' });
});

test('POST /api/auth/2fa/disable rejects an invalid code', async () => {
  const { app } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { verifyTotpResult: false },
  });

  const res = await request(app).post('/api/auth/2fa/disable').send({ code: '999999' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid 2FA code' });
});

test('POST /api/auth/2fa/disable disables 2FA and revokes devices', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { verifyTotpResult: true },
  });

  const res = await request(app).post('/api/auth/2fa/disable').send({ code: '123456' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, '2FA disabled successfully');
  const update = calls.db.find(
    (q) => q.sql.includes('totp_enabled = false') && q.sql.includes('totp_secret = NULL'),
  );
  assert.ok(update, 'totp fields cleared');
  assert.ok(calls.totpOps.some(([op]) => op === 'revokeAllDevices'));
  assert.ok(calls.totpAudit.some((a) => a.event === 'totp_disabled'));
});

test('GET /api/auth/2fa/backup-codes requires 2FA enabled', async () => {
  const { app } = buildApp();

  const res = await request(app).get('/api/auth/2fa/backup-codes');

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: '2FA is not enabled' });
});

test('GET /api/auth/2fa/backup-codes regenerates backup codes', async () => {
  const { app, calls } = buildApp({ userRow: { ...BASE_USER, totp_enabled: true } });

  const res = await request(app).get('/api/auth/2fa/backup-codes');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.backupCodes, ['AAAA-AAAA', 'BBBB-BBBB']);
  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET backup_codes'));
  assert.deepEqual(update.params[0], ['h-aaaa', 'h-bbbb']);
  assert.ok(calls.totpAudit.some((a) => a.event === 'backup_codes_regenerated'));
});

test('POST /api/auth/2fa/trust-device requires a code', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/2fa/trust-device').send({});

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: '2FA code is required to trust device' });
});

test('POST /api/auth/2fa/trust-device trusts the device with a valid code', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { verifyTotpResult: true },
  });

  const res = await request(app)
    .post('/api/auth/2fa/trust-device')
    .send({ code: '123456' })
    .set('User-Agent', 'Mozilla/5.0');

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Device trusted successfully');
  assert.ok(
    calls.totpOps.some(([op]) => op === 'trustDevice'),
    'device persisted as trusted',
  );
  assert.ok(calls.totpAudit.some((a) => a.event === 'device_trusted'));
});

test('GET /api/auth/2fa/devices lists trusted devices', async () => {
  const { app } = buildApp({ userRow: { ...BASE_USER, totp_enabled: true } });

  const res = await request(app).get('/api/auth/2fa/devices');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.devices, [{ id: 1, fingerprint: 'fp-x' }]);
});

test('DELETE /api/auth/2fa/devices/:id returns 404 for an unknown device', async () => {
  const { app } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { revokeDeviceResult: null },
  });

  const res = await request(app).delete('/api/auth/2fa/devices/999');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Device not found' });
});

test('DELETE /api/auth/2fa/devices/:id revokes a device', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    totp: { revokeDeviceResult: { id: 1 } },
  });

  const res = await request(app).delete('/api/auth/2fa/devices/1');

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Device removed');
  assert.ok(calls.totpAudit.some((a) => a.event === 'device_revoked'));
});

test('GET /api/auth/2fa/audit-log requires 2FA for non-admins', async () => {
  const { app } = buildApp();

  const res = await request(app).get('/api/auth/2fa/audit-log');

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: '2FA is not enabled' });
});

test('GET /api/auth/2fa/audit-log returns events and clamps the limit', async () => {
  const { app, calls } = buildApp({
    userRow: { ...BASE_USER, totp_enabled: true },
    queryImplOverride: async (sql, params, c) => {
      c.db.push({ sql, params });
      if (sql.includes('SELECT * FROM users WHERE id = $1')) {
        return { rows: [{ ...BASE_USER, totp_enabled: true }] };
      }
      if (sql.includes('FROM security_audit_log')) {
        c.auditParams = params;
        return { rows: [{ id: 1, event_type: 'totp_enabled' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/auth/2fa/audit-log?limit=999');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, [{ id: 1, event_type: 'totp_enabled' }]);
  assert.equal(calls.auditParams[0], USER_ID);
  assert.equal(calls.auditParams[1], 200, 'limit clamped to 200');
});

test('GET /api/auth/2fa/audit-log allows admins without 2FA', async () => {
  const { app } = buildApp({
    userRow: { ...BASE_USER, role: 'admin', totp_enabled: false },
  });

  const res = await request(app).get('/api/auth/2fa/audit-log');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
});

// ---------------------------------------------------------------------------
// REFRESH / LOGOUT / CSRF
// ---------------------------------------------------------------------------

test('POST /api/auth/refresh returns 401 without a refresh token', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/refresh');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'No refresh token provided' });
});

test('POST /api/auth/refresh returns 401 for an invalid refresh token', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', ['cp_refresh_token=invalid-token']);

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired refresh token' });
});

test('POST /api/auth/refresh rotates the refresh token and issues a new access token', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', [`cp_refresh_token=${VALID_REFRESH_TOKEN}`]);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'user@example.com');

  const revoked = calls.db.some(
    (q) => q.sql.includes('UPDATE refresh_tokens') && q.sql.includes('revoked_at = NOW()'),
  );
  assert.ok(revoked, 'old refresh token revoked');
  const inserted = calls.db.find(
    (q) =>
      q.sql.includes('INSERT INTO refresh_tokens') &&
      calls.db.indexOf(q) > calls.db.findIndex((x) => x.sql.includes('UPDATE refresh_tokens')),
  );
  assert.ok(inserted, 'new refresh token persisted');
  assert.ok(
    res.headers['set-cookie'].some((c) => c.startsWith('cp_refresh_token=')),
    'new refresh token cookie set',
  );
});

test('POST /api/auth/logout revokes the refresh token and clears cookies', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/logout')
    .set('Cookie', [`cp_refresh_token=${VALID_REFRESH_TOKEN}`, 'cp_csrf=abc']);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.ok(
    calls.db.some((q) => q.sql.includes('UPDATE refresh_tokens') && q.sql.includes('revoked_at')),
    'refresh token revoked',
  );
  const cleared = res.headers['set-cookie'].map((c) => c.split(';')[0].split('=')[0]);
  for (const name of ['cp_token', 'cp_refresh_token', 'cp_csrf']) {
    assert.ok(cleared.includes(name), `${name} cookie cleared`);
  }
});

test('POST /api/auth/logout succeeds without a refresh token', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/logout');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('GET /api/auth/csrf-token returns the csrf cookie value', async () => {
  const { app } = buildApp();

  const withoutCookie = await request(app).get('/api/auth/csrf-token');
  assert.equal(withoutCookie.status, 200);
  assert.deepEqual(withoutCookie.body, { csrfToken: null });

  const withCookie = await request(app)
    .get('/api/auth/csrf-token')
    .set('Cookie', ['cp_csrf=csrf-123']);
  assert.deepEqual(withCookie.body, { csrfToken: 'csrf-123' });
});

// ---------------------------------------------------------------------------
// PASSWORD RESET
// ---------------------------------------------------------------------------

test('POST /api/auth/forgot-password emails a reset link for a known email', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'user@example.com' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    message: 'If that email exists, a password reset link has been sent.',
  });

  const invalidated = calls.db.some((q) => q.sql.includes('UPDATE password_reset_tokens'));
  const inserted = calls.db.find((q) => q.sql.includes('INSERT INTO password_reset_tokens'));
  assert.ok(invalidated, 'previous unused tokens invalidated');
  assert.ok(inserted, 'new reset token inserted');

  const email = calls.emails.find(([kind]) => kind === 'sendEmail');
  assert.ok(email, 'reset email sent');
  assert.equal(email[1].subject, 'Reset your CrowdPay password');
  assert.match(email[1].text, /reset-password\?token=/);
});

test('POST /api/auth/forgot-password returns the same message for unknown emails', async () => {
  const { app, calls } = buildApp({ userMissing: true });

  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'ghost@example.com' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    message: 'If that email exists, a password reset link has been sent.',
  });
  assert.ok(!calls.emails.some(([kind]) => kind === 'sendEmail'), 'no reset email for unknown user');
});

test('POST /api/auth/forgot-password validates the email', async () => {
  const { app } = buildApp();

  const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nope' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/reset-password resets the password with a valid token', async () => {
  const { app, calls } = buildApp();

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: VALID_RESET_TOKEN, password: 'NewPassword1' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { message: 'Password reset successfully' });

  const update = calls.db.find((q) => q.sql.includes('UPDATE users SET password_hash'));
  assert.ok(update.params[0].startsWith('$2'), 'new password bcrypt-hashed');
  assert.equal(update.params[1], USER_ID);
  const markedUsed = calls.db.some(
    (q) => q.sql.includes('UPDATE password_reset_tokens') && q.sql.includes('used_at = NOW()'),
  );
  assert.ok(markedUsed, 'reset token marked used');
});

test('POST /api/auth/reset-password rejects an invalid token', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'bad-token', password: 'NewPassword1' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    error: 'Invalid or expired reset link. Please request a new one.',
  });
});

test('POST /api/auth/reset-password validates the new password', async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: VALID_RESET_TOKEN, password: 'weak' });

  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------

test('POST /api/auth/kyc/start returns the verified result directly', async () => {
  const { app } = buildApp({
    kyc: { startResult: { status: 'verified', subject: 'GABC' } },
  });

  const res = await request(app).post('/api/auth/kyc/start');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'verified', subject: 'GABC' });
});

test('POST /api/auth/kyc/start returns 201 for a pending session', async () => {
  const { app } = buildApp({
    kyc: { startResult: { status: 'pending', sessionUrl: 'https://persona/s' } },
  });

  const res = await request(app).post('/api/auth/kyc/start');

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
});

test('POST /api/auth/kyc/start returns 404 when the user is unknown to KYC', async () => {
  const { app } = buildApp({
    kyc: { startError: { statusCode: 404, message: 'User not found' } },
  });

  const res = await request(app).post('/api/auth/kyc/start');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'User not found' });
});

test('POST /api/auth/kyc/start returns 502 on provider failures', async () => {
  const { app } = buildApp({
    kyc: { startError: { message: 'Persona unavailable' } },
  });

  const res = await request(app).post('/api/auth/kyc/start');

  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'Persona unavailable' });
});

test('GET /api/auth/kyc/status returns the KYC status', async () => {
  const { app } = buildApp({ kyc: { statusResult: { status: 'verified' } } });

  const res = await request(app).get('/api/auth/kyc/status');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'verified' });
});

test('GET /api/auth/kyc/status returns 404 for unknown users', async () => {
  const { app } = buildApp({ kyc: { statusError: { statusCode: 404, message: 'No such user' } } });

  const res = await request(app).get('/api/auth/kyc/status');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'No such user' });
});