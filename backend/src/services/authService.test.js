const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildAuthService({ queryImpl } = {}) {
  const logs = { info: [], warn: [], error: [] };
  const mockDb = { query: queryImpl || (async () => ({ rows: [] })) };

  const service = proxyquire('./authService', {
    '../config/database': mockDb,
    '../config/logger': {
      info: (msg, meta) => logs.info.push({ msg, meta }),
      warn: (msg, meta) => logs.warn.push({ msg, meta }),
      error: (msg, meta) => logs.error.push({ msg, meta }),
      debug: () => {},
    },
    './totpService': {
      verifyTotp: () => true,
      enforce2faCheck: async () => ({ enforced: false }),
      generateFingerprint: () => 'fp-123',
      isDeviceTrusted: async () => false,
    },
    './stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
    './emailService': {
      sendWelcomeEmail: async () => {},
      sendWalletFundingFailedEmail: async () => {},
      sendEmail: async () => {},
    },
    './walletSecrets': {
      encryptWalletSecret: async () => 'encrypted-secret',
      withDecryptedTotpSecret: async (sec, id, fn) => fn('decrypted-totp'),
    },
    './kycProvider': {
      isKycRequiredForCampaigns: () => false,
    },
    './sessionService': {
      createUserSession: async () => {},
      recordLoginAttempt: async () => {},
      checkLoginAnomalies: async () => {},
    },
  });

  return { service, logs, mockDb };
}

test('hashToken produces deterministic sha256 hex digest', () => {
  const { service } = buildAuthService();
  const hash1 = service.hashToken('test-token-123');
  const hash2 = service.hashToken('test-token-123');
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64);
});

test('parseJwtExpiresIn and parseRefreshExpiresIn parse time strings correctly', () => {
  const { service } = buildAuthService();
  assert.equal(service.parseJwtExpiresIn('10s'), 10);
  assert.equal(service.parseJwtExpiresIn('15m'), 900);
  assert.equal(service.parseJwtExpiresIn('2h'), 7200);
  assert.equal(service.parseJwtExpiresIn('1d'), 86400);
  assert.equal(service.parseJwtExpiresIn('invalid'), 900);

  assert.equal(service.parseRefreshExpiresIn('12h'), 43200);
  assert.equal(service.parseRefreshExpiresIn('7d'), 604800);
  assert.equal(service.parseRefreshExpiresIn('unknown'), 604800);
});

test('generateTokens returns signed accessToken and random refreshToken', () => {
  const { service } = buildAuthService();
  const user = { id: 1, email: 'user@test.com', is_admin: false, role: 'contributor' };
  const tokens = service.generateTokens(user);

  assert.ok(tokens.accessToken);
  assert.ok(tokens.refreshToken);
  assert.equal(typeof tokens.accessToken, 'string');
  assert.equal(tokens.refreshToken.length, 64);
});

test('registerUser rejects invalid roles or duplicate email', async () => {
  const { service, mockDb } = buildAuthService();

  // Invalid role
  await assert.rejects(
    async () => {
      await service.registerUser({ email: 'test@example.com', password: 'password123', name: 'Tester', role: 'superadmin' });
    },
    { status: 400 }
  );

  // Duplicate email
  mockDb.query = async sql => {
    if (sql.includes('SELECT id FROM users')) {
      return { rows: [{ id: 99 }] };
    }
    return { rows: [] };
  };

  await assert.rejects(
    async () => {
      await service.registerUser({ email: 'test@example.com', password: 'password123', name: 'Tester', role: 'contributor' });
    },
    { status: 409 }
  );
});

test('authenticateUser rejects incorrect password', async () => {
  const bcrypt = require('bcryptjs');
  const validHash = await bcrypt.hash('correctPassword', 10);

  const { service, mockDb } = buildAuthService({
    queryImpl: async sql => {
      if (sql.includes('SELECT * FROM users')) {
        return {
          rows: [
            {
              id: 5,
              email: 'valid@example.com',
              password_hash: validHash,
              role: 'contributor',
              totp_enabled: false,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    async () => {
      await service.authenticateUser({ email: 'valid@example.com', password: 'wrongPassword' });
    },
    { status: 401 }
  );
});

test('authenticateUser succeeds with correct credentials and returns sanitized user', async () => {
  const bcrypt = require('bcryptjs');
  const validHash = await bcrypt.hash('secretPass123', 10);

  const { service, mockDb } = buildAuthService({
    queryImpl: async sql => {
      if (sql.includes('SELECT * FROM users')) {
        return {
          rows: [
            {
              id: 7,
              email: 'success@example.com',
              name: 'Success User',
              password_hash: validHash,
              wallet_public_key: 'GAAAA12345',
              role: 'creator',
              kyc_status: 'approved',
              kyc_completed_at: '2026-01-01',
              totp_enabled: false,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO refresh_tokens')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM refresh_tokens')) {
        return { rows: [{ id: 101 }] };
      }
      return { rows: [] };
    },
  });

  const res = await service.authenticateUser({ email: 'success@example.com', password: 'secretPass123' });

  assert.equal(res.requires2fa, false);
  assert.equal(res.user.id, 7);
  assert.equal(res.user.email, 'success@example.com');
  assert.equal(res.user.name, 'Success User');
  assert.ok(res.accessToken);
  assert.ok(res.refreshToken);
});
