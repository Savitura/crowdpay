'use strict';

// backend/src/services/embedTokenService.js
//
// Issue #690 — auth for the public embeddable discovery widget
// (GET /api/embed/discover?...&embedToken=<token>).
//
// Modeled directly on services/apiKeyService.js: raw token is shown to the
// creator once, only a bcrypt hash + short prefix are stored, and lookups
// are done by prefix then verified with bcrypt.compare.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const logger = require('../config/logger');

const TOKEN_PREFIX_LENGTH = 12;

function generateRawEmbedToken() {
  return `cped_${crypto.randomBytes(24).toString('hex')}`;
}

function getTokenPrefix(rawToken) {
  return rawToken.slice(0, TOKEN_PREFIX_LENGTH);
}

async function hashEmbedToken(rawToken) {
  return bcrypt.hash(rawToken, 10);
}

function mapTokenRow(row) {
  return {
    id: row.id,
    label: row.label,
    token_prefix: row.token_prefix,
    default_topic: row.default_topic,
    default_asset: row.default_asset,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

/**
 * Create a new embed token for a creator. Returns the raw token exactly once —
 * the caller must show/copy it immediately, it cannot be retrieved again.
 */
async function createEmbedToken(userId, { label, defaultTopic, defaultAsset } = {}) {
  const rawToken = generateRawEmbedToken();
  const tokenHash = await hashEmbedToken(rawToken);
  const tokenPrefix = getTokenPrefix(rawToken);

  const { rows } = await db.query(
    `INSERT INTO embed_tokens (user_id, label, token_hash, token_prefix, default_topic, default_asset)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      userId,
      label || 'Discovery widget',
      tokenHash,
      tokenPrefix,
      defaultTopic || null,
      defaultAsset || null,
    ]
  );

  return { ...mapTokenRow(rows[0]), token: rawToken };
}

async function listEmbedTokensForUser(userId) {
  const { rows } = await db.query(
    `SELECT * FROM embed_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(mapTokenRow);
}

async function revokeEmbedToken(userId, tokenId) {
  const { rows } = await db.query(
    `UPDATE embed_tokens SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [tokenId, userId]
  );
  return rows.length > 0;
}

/**
 * Validate a raw embed token from the query string. Returns the token row
 * (with user_id) on success, or null if missing/invalid/revoked.
 * Updates last_used_at on success (best-effort, not awaited by the caller).
 */
async function validateEmbedToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < TOKEN_PREFIX_LENGTH) {
    return null;
  }

  const prefix = getTokenPrefix(rawToken);
  const { rows } = await db.query(
    `SELECT * FROM embed_tokens WHERE token_prefix = $1 AND revoked_at IS NULL`,
    [prefix]
  );

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const matches = await bcrypt.compare(rawToken, row.token_hash);
    if (matches) {
      db.query(`UPDATE embed_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(
        err => {
          logger.warn('Failed to update embed token last_used_at', {
            error: err.message,
            id: row.id,
          });
        }
      );
      return row;
    }
  }
  return null;
}

module.exports = {
  createEmbedToken,
  listEmbedTokensForUser,
  revokeEmbedToken,
  validateEmbedToken,
};
