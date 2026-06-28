const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');

const KEY_PREFIX_LENGTH = 12;
const ALLOWED_SCOPES = new Set(['read', 'write', 'withdrawals', 'developer', 'full']);

function normalizeScopes(input) {
  if (!input || !Array.isArray(input) || !input.length) {
    return ['read', 'write', 'withdrawals'];
  }
  const out = [...new Set(input.filter((s) => typeof s === 'string' && ALLOWED_SCOPES.has(s)))];
  return out.length ? out : ['read', 'write', 'withdrawals'];
}

function generateRawApiKey() {
  return `cpk_${crypto.randomBytes(32).toString('hex')}`;
}

function getKeyPrefix(rawKey) {
  return rawKey.slice(0, KEY_PREFIX_LENGTH);
}

async function hashApiKey(rawKey) {
  return bcrypt.hash(rawKey, 10);
}

function mapKeyRow(row) {
  return {
    id: row.id,
    name: row.label,
    label: row.label,
    scopes: row.scopes,
    key_prefix: row.key_prefix,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

async function listApiKeysForUser(userId) {
  const { rows } = await db.query(
    `SELECT id, label, scopes, key_prefix, last_used_at, created_at, revoked_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(mapKeyRow);
}

async function createApiKeyForUser(userId, { name, label, scopes }) {
  const keyName = String(name || label || 'API key').trim() || 'API key';
  const normalizedScopes = normalizeScopes(scopes);
  const rawKey = generateRawApiKey();
  const keyPrefix = getKeyPrefix(rawKey);
  const keyHash = await hashApiKey(rawKey);

  const { rows } = await db.query(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, label, scopes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, label, scopes, key_prefix, created_at`,
    [userId, keyPrefix, keyHash, keyName, normalizedScopes]
  );

  return {
    ...mapKeyRow(rows[0]),
    api_key: rawKey,
    message: 'Store this key securely; it cannot be shown again.',
  };
}

async function revokeApiKeyForUser(userId, keyId) {
  const { rows } = await db.query(
    `UPDATE api_keys
     SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [keyId, userId]
  );
  return rows[0] || null;
}

async function authenticateCpkApiKey(rawKey) {
  const prefix = getKeyPrefix(rawKey);
  const { rows } = await db.query(
    `SELECT id, user_id, key_hash, scopes
     FROM api_keys
     WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [prefix]
  );

  for (const row of rows) {
    if (!row.key_hash.startsWith('$2')) continue;
    const valid = await bcrypt.compare(rawKey, row.key_hash);
    if (!valid) continue;

    await db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]);
    const { rows: userRows } = await db.query(
      'SELECT id, role, is_admin FROM users WHERE id = $1',
      [row.user_id]
    );
    const user = userRows[0] || {};
    return {
      userId: row.user_id,
      role: user.is_admin ? 'admin' : user.role || 'contributor',
      is_admin: user.is_admin,
      apiKeyId: row.id,
      scopes: row.scopes || [],
    };
  }

  return null;
}

module.exports = {
  ALLOWED_SCOPES,
  KEY_PREFIX_LENGTH,
  generateRawApiKey,
  getKeyPrefix,
  hashApiKey,
  normalizeScopes,
  listApiKeysForUser,
  createApiKeyForUser,
  revokeApiKeyForUser,
  authenticateCpkApiKey,
};
