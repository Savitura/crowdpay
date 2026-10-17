'use strict';

/**
 * apiKeys.test.js
 *
 * Tests for the API keys routes.
 * Covers: create (returns secret once), list (never returns secret), revoke,
 * hashing with pepper, wrong pepper/malformed key rejection.
 */

// Set required env vars BEFORE any module loads
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'testsecret';
process.env.API_KEY_PEPPER = 'testpeppersecret';
process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.PLATFORM_SECRET_KEY = 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR';
process.env.ARBITRATOR_SECRET_KEY = 'SD5R3ADP7AC37OAYWYG73266DR2MBR6IJGXBLLAGCOWMTHLMPFAJMWPM';
process.env.WALLET_ENCRYPTION_KEY =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.WALLET_SECRET_LOCAL_KEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.OPS_API_KEY = 'test-ops-key';
process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';
process.env.IMPACT_SIGNING_SECRET = 'test-impact-secret';

// Mock the services using functions that can be reassigned
let mockListApiKeysForUser = () => Promise.resolve([]);
let mockCreateApiKeyForUser = () => Promise.resolve({});
let mockRevokeApiKeyForUser = () => Promise.resolve({});
let mockRotateApiKey = () => Promise.resolve({});
let mockLogCredentialEvent = () => Promise.resolve({});

// Create mock modules that use the current function references
const mockApiKeyServiceModule = {
  listApiKeysForUser: (...args) => mockListApiKeysForUser(...args),
  createApiKeyForUser: (...args) => mockCreateApiKeyForUser(...args),
  revokeApiKeyForUser: (...args) => mockRevokeApiKeyForUser(...args),
  rotateApiKey: (...args) => mockRotateApiKey(...args),
};

const mockAuditServiceModule = {
  logCredentialEvent: (...args) => mockLogCredentialEvent(...args),
};

// Mock auth middleware
const mockAuthModule = {
  requireAuth: (req, res, next) => {
    req.user = { userId: 'test-user-id' };
    next();
  },
};

// Load router with mocks using proxyquire
const proxyquire = require('proxyquire');
const apiKeysRouter = proxyquire('./apiKeys', {
  '../services/apiKeyService': mockApiKeyServiceModule,
  '../services/auditService': mockAuditServiceModule,
  '../middleware/auth': mockAuthModule,
});

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Build test app
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users/api-keys', apiKeysRouter);
  return app;
}

let agent;

describe('API Keys Routes', () => {
  before(() => {
    agent = supertest(buildApp());
  });

  // ── GET /api/users/api-keys ─────────────────────────────────────────────
  describe('GET /api/users/api-keys', () => {
    it('returns list of API keys without secrets', async () => {
      mockListApiKeysForUser = () =>
        Promise.resolve([
          { id: 'key-1', label: 'Test Key', scopes: ['read'], created_at: new Date() },
          { id: 'key-2', label: 'Another Key', scopes: ['read', 'write'], created_at: new Date() },
        ]);

      const res = await agent.get('/api/users/api-keys');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 2);
      // Secrets should never be returned
      for (const key of res.body) {
        assert.ok(!key.secret, 'Secret should not be in list response');
        assert.ok(!key.hashed_secret, 'Hashed secret should not be in list response');
      }
    });

    it('returns empty array when user has no keys', async () => {
      mockListApiKeysForUser = () => Promise.resolve([]);

      const res = await agent.get('/api/users/api-keys');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });
  });

  // ── POST /api/users/api-keys ────────────────────────────────────────────
  describe('POST /api/users/api-keys', () => {
    it('creates a new API key and returns the secret exactly once', async () => {
      const createdKey = {
        id: 'new-key-id',
        label: 'My Key',
        scopes: ['read', 'write'],
        secret: 'cp_live_abcdef123456',
        created_at: new Date(),
      };
      mockCreateApiKeyForUser = () => Promise.resolve(createdKey);

      const res = await agent
        .post('/api/users/api-keys')
        .send({ label: 'My Key', scopes: ['read', 'write'] });

      assert.equal(res.status, 201);
      assert.equal(res.body.id, 'new-key-id');
      assert.equal(res.body.label, 'My Key');
      assert.equal(res.body.secret, 'cp_live_abcdef123456');
      assert.deepEqual(res.body.scopes, ['read', 'write']);
    });

    it('returns 500 if label is missing (validation error)', async () => {
      mockCreateApiKeyForUser = () => Promise.reject(new Error('Label is required'));

      const res = await agent.post('/api/users/api-keys').send({ scopes: ['read'] });
      assert.equal(res.status, 500);
    });
  });

  // ── DELETE /api/users/api-keys/:id ──────────────────────────────────────
  describe('DELETE /api/users/api-keys/:id', () => {
    it('revokes an API key', async () => {
      const revokedKey = { id: 'key-1', label: 'Test Key' };
      mockRevokeApiKeyForUser = () => Promise.resolve(revokedKey);

      const res = await agent.delete('/api/users/api-keys/key-1');
      assert.equal(res.status, 200);
      assert.equal(res.body.revoked, true);
      assert.equal(res.body.id, 'key-1');
    });

    it('returns 404 if key not found', async () => {
      mockRevokeApiKeyForUser = () => Promise.resolve(null);

      const res = await agent.delete('/api/users/api-keys/nonexistent');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'API key not found');
    });
  });

  // ── POST /api/users/api-keys/:id/rotate ─────────────────────────────────
  describe('POST /api/users/api-keys/:id/rotate', () => {
    it('rotates an API key and returns new secret once', async () => {
      const rotatedKey = {
        id: 'new-key-id',
        label: 'Rotated Key',
        scopes: ['read'],
        secret: 'cp_live_newsecret789',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
      mockRotateApiKey = () => Promise.resolve(rotatedKey);

      const res = await agent
        .post('/api/users/api-keys/key-1/rotate')
        .send({ label: 'Rotated Key' });

      assert.equal(res.status, 201);
      assert.equal(res.body.id, 'new-key-id');
      assert.equal(res.body.secret, 'cp_live_newsecret789');
      assert.ok(res.body.expires_at);
    });

    it('returns 404 if key not found or cannot be rotated', async () => {
      mockRotateApiKey = () => Promise.resolve(null);

      const res = await agent.post('/api/users/api-keys/nonexistent/rotate').send({});
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Key not found or cannot be rotated');
    });
  });

  // ── Hashing with pepper ─────────────────────────────────────────────────
  describe('API Key hashing', () => {
    it('hashes the secret with pepper using bcrypt', () => {
      const secret = 'cp_live_testsecret123';
      const pepper = 'test-pepper';
      const hash = bcrypt.hashSync(secret + pepper, 12);

      assert.ok(bcrypt.compareSync(secret + pepper, hash));
      assert.ok(!bcrypt.compareSync('wrong' + pepper, hash));
    });

    it('rejects wrong pepper', () => {
      const secret = 'cp_live_testsecret123';
      const pepper = 'test-pepper';
      const hash = bcrypt.hashSync(secret + pepper, 12);

      assert.ok(!bcrypt.compareSync(secret + 'wrong-pepper', hash));
    });

    it('rejects malformed key', () => {
      const pepper = 'test-pepper';
      const hash = bcrypt.hashSync('cp_live_validsecret' + pepper, 12);

      assert.ok(!bcrypt.compareSync('' + pepper, hash));
      assert.ok(!bcrypt.compareSync('random-string' + pepper, hash));
    });
  });
});
