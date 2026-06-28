const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const MODULE_PATH = './apiKeyService';

function mockDb(queries) {
  return {
    async query(text, params) {
      const handler = queries.find((q) => {
        if (typeof q.match === 'function') return q.match(text, params);
        return text.startsWith(q.startsWith);
      });
      if (!handler) throw new Error(`Unexpected query: ${text}`);
      return handler.run(text, params);
    },
  };
}

test('generateRawApiKey uses cpk_ prefix and 64 hex chars', () => {
  const { generateRawApiKey } = require(MODULE_PATH);
  const key = generateRawApiKey();
  assert.match(key, /^cpk_[0-9a-f]{64}$/);
});

test('getKeyPrefix returns first 12 characters', () => {
  const { getKeyPrefix } = require(MODULE_PATH);
  const key = 'cpk_abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456';
  assert.equal(getKeyPrefix(key), 'cpk_abcdef12');
});

test('normalizeScopes defaults when empty', () => {
  const { normalizeScopes } = require(MODULE_PATH);
  assert.deepEqual(normalizeScopes(), ['read', 'write', 'withdrawals']);
  assert.deepEqual(normalizeScopes([]), ['read', 'write', 'withdrawals']);
});

test('normalizeScopes filters unknown scopes', () => {
  const { normalizeScopes } = require(MODULE_PATH);
  assert.deepEqual(normalizeScopes(['read', 'developer', 'bad']), ['read', 'developer']);
});

test('authenticateCpkApiKey validates bcrypt hash and updates last_used_at', async () => {
  const rawKey = 'cpk_' + 'a'.repeat(64);
  const keyHash = await bcrypt.hash(rawKey, 4);
  const updates = [];

  const db = mockDb([
    {
      startsWith: 'SELECT id, user_id, key_hash, scopes',
      run() {
        return {
          rows: [{
            id: 'key-1',
            user_id: 'user-1',
            key_hash: keyHash,
            scopes: ['read', 'write'],
          }],
        };
      },
    },
    {
      startsWith: 'UPDATE api_keys SET last_used_at',
      run(_text, params) {
        updates.push(params);
        return { rows: [] };
      },
    },
    {
      startsWith: 'SELECT id, role, is_admin FROM users',
      run() {
        return { rows: [{ id: 'user-1', role: 'creator', is_admin: false }] };
      },
    },
  ]);

  const originalDb = require('../config/database');
  require.cache[require.resolve('../config/database')].exports = db;
  delete require.cache[require.resolve(MODULE_PATH)];
  const { authenticateCpkApiKey } = require(MODULE_PATH);

  const auth = await authenticateCpkApiKey(rawKey);
  assert.equal(auth.userId, 'user-1');
  assert.equal(auth.apiKeyId, 'key-1');
  assert.deepEqual(auth.scopes, ['read', 'write']);
  assert.deepEqual(updates, [['key-1']]);

  require.cache[require.resolve('../config/database')].exports = originalDb;
  delete require.cache[require.resolve(MODULE_PATH)];
});

test('authenticateCpkApiKey rejects revoked or invalid keys', async () => {
  const rawKey = 'cpk_' + 'b'.repeat(64);
  const keyHash = await bcrypt.hash('cpk_' + 'c'.repeat(64), 4);

  const db = mockDb([
    {
      startsWith: 'SELECT id, user_id, key_hash, scopes',
      run() {
        return {
          rows: [{
            id: 'key-2',
            user_id: 'user-2',
            key_hash: keyHash,
            scopes: ['read'],
          }],
        };
      },
    },
  ]);

  const originalDb = require('../config/database');
  require.cache[require.resolve('../config/database')].exports = db;
  delete require.cache[require.resolve(MODULE_PATH)];
  const { authenticateCpkApiKey } = require(MODULE_PATH);

  const auth = await authenticateCpkApiKey(rawKey);
  assert.equal(auth, null);

  require.cache[require.resolve('../config/database')].exports = originalDb;
  delete require.cache[require.resolve(MODULE_PATH)];
});

test('createApiKeyForUser stores bcrypt hash and returns raw key once', async () => {
  const inserts = [];
  const db = mockDb([
    {
      startsWith: 'INSERT INTO api_keys',
      run(_text, params) {
        inserts.push(params);
        return {
          rows: [{
            id: 'new-key',
            label: params[3],
            scopes: params[4],
            key_prefix: params[1],
            created_at: new Date().toISOString(),
          }],
        };
      },
    },
  ]);

  const originalDb = require('../config/database');
  require.cache[require.resolve('../config/database')].exports = db;
  delete require.cache[require.resolve(MODULE_PATH)];
  const { createApiKeyForUser } = require(MODULE_PATH);

  const created = await createApiKeyForUser('user-9', { name: 'My bot' });
  assert.match(created.api_key, /^cpk_[0-9a-f]{64}$/);
  assert.equal(created.name, 'My bot');
  assert.equal(created.key_prefix, created.api_key.slice(0, 12));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 'user-9');
  assert.equal(inserts[0][3], 'My bot');
  assert.match(inserts[0][2], /^\$2[aby]\$/);

  const valid = await bcrypt.compare(created.api_key, inserts[0][2]);
  assert.equal(valid, true);

  require.cache[require.resolve('../config/database')].exports = originalDb;
  delete require.cache[require.resolve(MODULE_PATH)];
});
