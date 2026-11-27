const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const otplib = require('otplib');
const bcrypt = require('bcryptjs');

function loadTotpService({ queryImpl = async () => ({ rows: [] }), loggerImpl = {} } = {}) {
  return proxyquire('./totpService', {
    '../config/database': { query: queryImpl },
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
      ...loggerImpl,
    },
  });
}

test('generateSecret returns a valid base32 secret of 32 characters', () => {
  const totpService = loadTotpService();
  const secret1 = totpService.generateSecret();
  const secret2 = totpService.generateSecret();

  assert.equal(typeof secret1, 'string');
  assert.equal(secret1.length, 32);
  assert.match(secret1, /^[A-Z2-7]+$/);
  assert.notEqual(secret1, secret2);
});

test('buildOtpauthUri creates a valid otpauth keyuri with issuer and email', () => {
  const totpService = loadTotpService();
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const uri = totpService.buildOtpauthUri('user@example.com', secret);

  assert.ok(uri.startsWith('otpauth://totp/CrowdPay:user%40example.com?'));
  assert.ok(uri.includes(`secret=${secret}`));
  assert.ok(uri.includes('issuer=CrowdPay'));
});

test('generateQrCode returns a base64 png data URL', async () => {
  const totpService = loadTotpService();
  const uri = 'otpauth://totp/CrowdPay:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=CrowdPay';
  const qrDataUrl = await totpService.generateQrCode(uri);

  assert.equal(typeof qrDataUrl, 'string');
  assert.ok(qrDataUrl.startsWith('data:image/png;base64,'));
});

test('verifyTotp verifies current token successfully', () => {
  const totpService = loadTotpService();
  const secret = totpService.generateSecret();
  const currentToken = otplib.generateSync({ secret });

  assert.equal(totpService.verifyTotp(secret, currentToken), true);
});

test('verifyTotp respects window tolerance (window: 1 = +/- 30s)', () => {
  const totpService = loadTotpService();
  const secret = totpService.generateSecret();
  const currentEpoch = Math.floor(Date.now() / 1000);

  // Past token within window (30s past / 1 time step)
  const pastToken = otplib.generateSync({ secret, epoch: currentEpoch - 30 });
  assert.equal(totpService.verifyTotp(secret, pastToken), true);

  // Future token within window (30s future / 1 time step)
  const futureToken = otplib.generateSync({ secret, epoch: currentEpoch + 30 });
  assert.equal(totpService.verifyTotp(secret, futureToken), true);
});

test('verifyTotp rejects expired tokens outside window', () => {
  const totpService = loadTotpService();
  const secret = totpService.generateSecret();
  const currentEpoch = Math.floor(Date.now() / 1000);

  // Expired token (2 time steps / 65s in past)
  const expiredToken = otplib.generateSync({ secret, epoch: currentEpoch - 65 });
  assert.equal(totpService.verifyTotp(secret, expiredToken), false);

  // Far expired token (5 minutes in past)
  const farExpiredToken = otplib.generateSync({ secret, epoch: currentEpoch - 300 });
  assert.equal(totpService.verifyTotp(secret, farExpiredToken), false);

  // Future token outside window (2 time steps / 65s in future)
  const farFutureToken = otplib.generateSync({ secret, epoch: currentEpoch + 65 });
  assert.equal(totpService.verifyTotp(secret, farFutureToken), false);
});

test('verifyTotp rejects malformed, invalid length, and non-numeric tokens', () => {
  const totpService = loadTotpService();
  const secret = totpService.generateSecret();

  // Non-numeric tokens
  assert.equal(totpService.verifyTotp(secret, 'abcdef'), false);
  assert.equal(totpService.verifyTotp(secret, '12a456'), false);
  assert.equal(totpService.verifyTotp(secret, '------'), false);

  // Invalid length tokens
  assert.equal(totpService.verifyTotp(secret, '123'), false);
  assert.equal(totpService.verifyTotp(secret, '12345'), false);
  assert.equal(totpService.verifyTotp(secret, '1234567'), false);
  assert.equal(totpService.verifyTotp(secret, ''), false);

  // Non-string / null / undefined inputs
  assert.equal(totpService.verifyTotp(secret, null), false);
  assert.equal(totpService.verifyTotp(secret, undefined), false);
  assert.equal(totpService.verifyTotp(secret, 123456), false);
  assert.equal(totpService.verifyTotp(secret, {}), false);

  // Incorrect 6-digit token
  const currentToken = otplib.generateSync({ secret });
  const wrongToken = currentToken === '999999' ? '888888' : '999999';
  assert.equal(totpService.verifyTotp(secret, wrongToken), false);
});

test('verifyTotp rejects tokens when secret is missing or mismatched', () => {
  const totpService = loadTotpService();
  const secretA = totpService.generateSecret();
  const secretB = totpService.generateSecret();
  const tokenA = otplib.generateSync({ secret: secretA });

  // Mismatched secret
  assert.equal(totpService.verifyTotp(secretB, tokenA), false);

  // Missing or empty secret
  assert.equal(totpService.verifyTotp('', tokenA), false);
  assert.equal(totpService.verifyTotp(null, tokenA), false);
  assert.equal(totpService.verifyTotp(undefined, tokenA), false);
  assert.equal(totpService.verifyTotp('INVALID_BASE32_1!@#$', tokenA), false);
});

test('generateBackupCodes produces 10 single-use hex codes with bcrypt hashes', async () => {
  const totpService = loadTotpService();
  const { raw, hashed } = await totpService.generateBackupCodes();

  assert.equal(raw.length, 10);
  assert.equal(hashed.length, 10);
  assert.equal(raw.length, totpService.BACKUP_CODE_COUNT);

  for (let i = 0; i < raw.length; i++) {
    assert.match(raw[i], /^[0-9a-f]{8}$/);
    const isValid = await bcrypt.compare(raw[i], hashed[i]);
    assert.equal(isValid, true);
  }
});

test('verifyBackupCode verifies matching code and returns valid flag and index', async () => {
  const totpService = loadTotpService();
  const codes = ['code0001', 'code0002', 'code0003'];
  const hashed = await Promise.all(codes.map(c => bcrypt.hash(c, 10)));

  // First code
  const result0 = await totpService.verifyBackupCode(hashed, 'code0001');
  assert.deepEqual(result0, { valid: true, index: 0 });

  // Middle code
  const result1 = await totpService.verifyBackupCode(hashed, 'code0002');
  assert.deepEqual(result1, { valid: true, index: 1 });

  // Last code
  const result2 = await totpService.verifyBackupCode(hashed, 'code0003');
  assert.deepEqual(result2, { valid: true, index: 2 });

  // Non-matching code
  const resultInvalid = await totpService.verifyBackupCode(hashed, 'wrongcode');
  assert.deepEqual(resultInvalid, { valid: false, index: -1 });

  // Empty backup codes array
  const resultEmpty = await totpService.verifyBackupCode([], 'code0001');
  assert.deepEqual(resultEmpty, { valid: false, index: -1 });
});

test('removeBackupCode removes used code at index and updates database', async () => {
  let capturedQuery;
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      capturedQuery = { sql, params };
      return { rowCount: 1 };
    },
  });

  const codes = ['hash1', 'hash2', 'hash3'];
  await totpService.removeBackupCode(42, codes, 1);

  assert.deepEqual(codes, ['hash1', 'hash3']);
  assert.match(capturedQuery.sql, /UPDATE users SET backup_codes = \$1 WHERE id = \$2/);
  assert.deepEqual(capturedQuery.params, [['hash1', 'hash3'], 42]);
});

test('generateFingerprint creates sha256 of user-agent and accept-language headers', () => {
  const totpService = loadTotpService();

  const req1 = {
    headers: {
      'user-agent': 'Mozilla/5.0 TestBrowser',
      'accept-language': 'en-US,en;q=0.9',
    },
  };
  const fp1 = totpService.generateFingerprint(req1);
  assert.match(fp1, /^[0-9a-f]{64}$/);

  // Same headers yield identical fingerprint
  const fp1Copy = totpService.generateFingerprint({ headers: { ...req1.headers } });
  assert.equal(fp1, fp1Copy);

  // Different headers yield different fingerprint
  const req2 = {
    headers: {
      'user-agent': 'DifferentBrowser/1.0',
      'accept-language': 'en-US,en;q=0.9',
    },
  };
  const fp2 = totpService.generateFingerprint(req2);
  assert.notEqual(fp1, fp2);

  // Missing or empty headers handled gracefully
  const emptyFp = totpService.generateFingerprint({ headers: {} });
  assert.match(emptyFp, /^[0-9a-f]{64}$/);
});

test('parseJwtExpiresIn handles various time units and defaults on invalid input', () => {
  const totpService = loadTotpService();

  assert.equal(totpService.parseJwtExpiresIn('30s'), 30);
  assert.equal(totpService.parseJwtExpiresIn('15m'), 900);
  assert.equal(totpService.parseJwtExpiresIn('2h'), 7200);
  assert.equal(totpService.parseJwtExpiresIn('30d'), 30 * 24 * 3600);

  // Invalid formats default to 900
  assert.equal(totpService.parseJwtExpiresIn('invalid'), 900);
  assert.equal(totpService.parseJwtExpiresIn(''), 900);
  assert.equal(totpService.parseJwtExpiresIn(null), 900);
  assert.equal(totpService.parseJwtExpiresIn(123), 900);
});

test('getDeviceTrustTtlMs returns milliseconds based on default or env var', () => {
  const totpService = loadTotpService();

  const originalDays = process.env.DEVICE_TRUST_DAYS;
  delete process.env.DEVICE_TRUST_DAYS;
  assert.equal(totpService.getDeviceTrustTtlMs(), 30 * 24 * 60 * 60 * 1000);

  process.env.DEVICE_TRUST_DAYS = '14';
  assert.equal(totpService.getDeviceTrustTtlMs(), 14 * 24 * 60 * 60 * 1000);

  if (originalDays !== undefined) {
    process.env.DEVICE_TRUST_DAYS = originalDays;
  } else {
    delete process.env.DEVICE_TRUST_DAYS;
  }
});

test('isDeviceTrusted returns true when active device row exists, false otherwise', async () => {
  let queryUserId;
  let queryFp;
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      queryUserId = params[0];
      queryFp = params[1];
      if (queryUserId === 1 && queryFp === 'trusted-fp') {
        return { rows: [{ id: 10 }] };
      }
      return { rows: [] };
    },
  });

  const trusted = await totpService.isDeviceTrusted(1, 'trusted-fp');
  assert.equal(trusted, true);

  const untrusted = await totpService.isDeviceTrusted(1, 'unknown-fp');
  assert.equal(untrusted, false);
});

test('trustDevice inserts or updates trusted_devices with device name, ip, and expiration', async () => {
  let capturedQuery;
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      capturedQuery = { sql, params };
      return { rowCount: 1 };
    },
  });

  const req = {
    headers: { 'user-agent': 'Chrome/120.0' },
    ip: '192.168.1.100',
  };

  await totpService.trustDevice(1, 'fingerprint-123', req);

  assert.match(capturedQuery.sql, /INSERT INTO trusted_devices/);
  assert.match(capturedQuery.sql, /ON CONFLICT \(user_id, device_fingerprint\)/);
  assert.equal(capturedQuery.params[0], 1);
  assert.equal(capturedQuery.params[1], 'fingerprint-123');
  assert.equal(capturedQuery.params[2], 'Chrome/120.0');
  assert.equal(capturedQuery.params[3], '192.168.1.100');
  assert.ok(capturedQuery.params[4] instanceof Date);

  // Fallback to connection.remoteAddress and Unknown device
  const fallbackReq = {
    headers: {},
    connection: { remoteAddress: '10.0.0.1' },
  };
  await totpService.trustDevice(2, 'fp-456', fallbackReq);
  assert.equal(capturedQuery.params[2], 'Unknown device');
  assert.equal(capturedQuery.params[3], '10.0.0.1');
});

test('revokeDevice deletes device by id and userId', async () => {
  let capturedParams;
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      capturedParams = params;
      if (params[0] === 10) return { rowCount: 1 };
      return { rowCount: 0 };
    },
  });

  const success = await totpService.revokeDevice(1, 10);
  assert.equal(success, true);
  assert.deepEqual(capturedParams, [10, 1]);

  const notFound = await totpService.revokeDevice(1, 999);
  assert.equal(notFound, false);
});

test('revokeAllDevices removes all trusted devices for user', async () => {
  let capturedParams;
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      capturedParams = params;
      return { rowCount: 3 };
    },
  });

  await totpService.revokeAllDevices(7);
  assert.deepEqual(capturedParams, [7]);
});

test('getUserDevices returns active trusted devices for user', async () => {
  const mockDevices = [
    {
      id: 1,
      device_name: 'Chrome',
      ip_address: '1.2.3.4',
      trusted_at: new Date(),
      expires_at: new Date(),
    },
  ];
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      assert.equal(params[0], 42);
      return { rows: mockDevices };
    },
  });

  const devices = await totpService.getUserDevices(42);
  assert.deepEqual(devices, mockDevices);
});

test('enforce2faCheck returns enforced when policy requires 2FA but not enabled', async () => {
  const totpService = loadTotpService();

  const res1 = await totpService.enforce2faCheck({ enforce_2fa: true, totp_enabled: false });
  assert.deepEqual(res1, {
    enforced: true,
    message: '2FA is required for your account. Please set up 2FA before continuing.',
  });

  const res2 = await totpService.enforce2faCheck({ enforce_2fa: true, totp_enabled: true });
  assert.deepEqual(res2, { enforced: false });

  const res3 = await totpService.enforce2faCheck({ enforce_2fa: false, totp_enabled: false });
  assert.deepEqual(res3, { enforced: false });
});

test('logAuditEvent records security event to database and logger', async () => {
  let capturedQuery;
  let loggedEvent;
  const totpService = loadTotpService({
    queryImpl: async (sql, params) => {
      capturedQuery = { sql, params };
      return { rowCount: 1 };
    },
    loggerImpl: {
      info: (msg, data) => {
        loggedEvent = { msg, data };
      },
    },
  });

  const req = {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'AuditAgent/1.0' },
  };

  await totpService.logAuditEvent(5, 'totp_challenge_success', req, { method: 'totp' });

  assert.match(capturedQuery.sql, /INSERT INTO security_audit_log/);
  assert.equal(capturedQuery.params[0], 5);
  assert.equal(capturedQuery.params[1], 'totp_challenge_success');
  assert.equal(capturedQuery.params[2], '127.0.0.1');
  assert.equal(capturedQuery.params[3], 'AuditAgent/1.0');
  assert.equal(capturedQuery.params[4], JSON.stringify({ method: 'totp' }));

  assert.equal(loggedEvent.msg, '2FA audit event');
  assert.equal(loggedEvent.data.event, 'totp_challenge_success');
  assert.equal(loggedEvent.data.userId, 5);
  assert.equal(loggedEvent.data.ip, '127.0.0.1');
});
