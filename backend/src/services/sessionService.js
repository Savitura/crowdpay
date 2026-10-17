const db = require('../config/database');
const crypto = require('crypto');
const { lookupIp } = require('./geoipService');

const MAX_SESSIONS_PER_USER = 5;

/**
 * Generate a device fingerprint from request headers.
 * @param {object} req - Express request object
 * @returns {string}
 */
function generateDeviceFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const acceptEncoding = req.headers['accept-encoding'] || '';

  const fingerprintData = `${userAgent}|${acceptLanguage}|${acceptEncoding}`;
  return crypto.createHash('sha256').update(fingerprintData, 'utf8').digest('hex').substring(0, 32);
}

/**
 * Format the location columns of a session/alert row for display.
 * @param {object} row - Row with location_city / location_region / location_country
 * @returns {string|null} - e.g. "San Francisco, California, US"
 */
function formatLocation(row) {
  const parts = [row.location_city, row.location_region, row.location_country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Create a new user session record.
 * @param {string} userId - The user's ID
 * @param {string} refreshTokenId - The refresh token ID
 * @param {object} req - Express request object
 * @returns {Promise<object>}
 */
async function createUserSession(userId, refreshTokenId, req) {
  const deviceFingerprint = generateDeviceFingerprint(req);
  const ip = req.ip || req.connection?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;
  const { country, region, city } = await lookupIp(ip);

  // Check concurrent session limit
  const { rows: existingSessions } = await db.query(
    `SELECT COUNT(*)::int AS count FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );

  if (existingSessions[0]?.count >= MAX_SESSIONS_PER_USER) {
    // Revoke oldest session
    await db.query(
      `UPDATE user_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId]
    );
  }

  const { rows } = await db.query(
    `INSERT INTO user_sessions
     (user_id, refresh_token_id, device_fingerprint, ip_address, user_agent, location_country, location_region, location_city)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id, device_fingerprint, ip_address, user_agent, location_country, location_region, location_city, created_at, last_seen_at`,
    [userId, refreshTokenId, deviceFingerprint, ip, userAgent, country, region, city]
  );

  return rows[0];
}

/**
 * List all active sessions for a user.
 * @param {string} userId - The user's ID
 * @returns {Promise<Array>}
 */
async function listUserSessions(userId) {
  const { rows } = await db.query(
    `SELECT id, device_fingerprint, ip_address, user_agent, location_country, location_region, location_city,
            created_at, last_seen_at
     FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY last_seen_at DESC`,
    [userId]
  );

  return rows.map(session => ({
    id: session.id,
    device: session.device_fingerprint
      ? `Device ${session.device_fingerprint.substring(0, 8)}`
      : 'Unknown Device',
    location: formatLocation(session) || session.ip_address || 'Unknown Location',
    lastSeen: session.last_seen_at,
    userAgent: session.user_agent,
    ip: session.ip_address,
  }));
}

/**
 * Revoke a specific session.
 * @param {string} sessionId - The session ID
 * @param {string} userId - The user's ID (for verification)
 * @returns {Promise<boolean>} - True if session was revoked
 */
async function revokeUserSession(sessionId, userId) {
  const { rowCount } = await db.query(
    `UPDATE user_sessions SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId]
  );

  return rowCount > 0;
}

/**
 * Update the last_seen_at timestamp for a session.
 * @param {string} refreshTokenId - The refresh token ID
 */
async function updateSessionLastSeen(refreshTokenId) {
  await db.query(
    `UPDATE user_sessions SET last_seen_at = NOW() WHERE refresh_token_id = $1 AND revoked_at IS NULL`,
    [refreshTokenId]
  );
}

/**
 * Record a login attempt for monitoring.
 * @param {object} options - Login attempt details
 */
async function recordLoginAttempt(options) {
  const {
    userId,
    email,
    ip,
    userAgent,
    deviceFingerprint,
    success,
    failureReason,
    locationCountry,
    locationRegion,
    locationCity,
  } = options;

  // Resolve the location when the caller did not supply one, so failed
  // attempts carry the same geo context as sessions do.
  const location =
    locationCountry === undefined && locationRegion === undefined && locationCity === undefined
      ? await lookupIp(ip)
      : {
          country: locationCountry ?? null,
          region: locationRegion ?? null,
          city: locationCity ?? null,
        };

  await db.query(
    `INSERT INTO login_attempts
     (user_id, email, ip_address, user_agent, device_fingerprint, success, failure_reason, location_country, location_region, location_city)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      userId,
      email,
      ip,
      userAgent,
      deviceFingerprint,
      success,
      failureReason,
      location.country,
      location.region,
      location.city,
    ]
  );
}

/**
 * Check for suspicious login activity and create alerts.
 * @param {string} userId - The user's ID
 * @param {string} email - The user's email
 * @param {object} req - Express request object
 * @returns {Promise<Array>} - List of alert types created
 */
async function checkLoginAnomalies(userId, email, req) {
  const ip = req.ip || req.connection?.remoteAddress;
  const userAgent = req.headers['user-agent'] || null;
  const deviceFingerprint = generateDeviceFingerprint(req);
  const { country, region, city } = await lookupIp(ip);

  const alerts = [];

  // Check for new device
  const { rows: existingDevices } = await db.query(
    `SELECT 1 FROM user_sessions WHERE user_id = $1 AND device_fingerprint = $2 AND revoked_at IS NULL`,
    [userId, deviceFingerprint]
  );

  if (existingDevices.length === 0) {
    await db.query(
      `INSERT INTO login_alerts
       (user_id, alert_type, ip_address, device_fingerprint, location_country, location_region, location_city, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        'new_device',
        ip,
        deviceFingerprint,
        country,
        region,
        city,
        JSON.stringify({ userAgent }),
      ]
    );
    alerts.push('new_device');
  }

  // Check for new location
  if (country) {
    const { rows: existingLocations } = await db.query(
      `SELECT 1 FROM user_sessions WHERE user_id = $1 AND location_country = $2 AND revoked_at IS NULL`,
      [userId, country]
    );

    if (existingLocations.length === 0) {
      await db.query(
        `INSERT INTO login_alerts
         (user_id, alert_type, ip_address, device_fingerprint, location_country, location_region, location_city, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          'new_location',
          ip,
          deviceFingerprint,
          country,
          region,
          city,
          JSON.stringify({ userAgent }),
        ]
      );
      alerts.push('new_location');
    }
  }

  return alerts;
}

/**
 * Get login alerts for a user.
 * @param {string} userId - The user's ID
 * @param {object} options - Options (limit, offset, acknowledged)
 * @returns {Promise<{alerts: Array, total: number}>}
 */
async function getUserLoginAlerts(userId, options = {}) {
  const { limit = 50, offset = 0, acknowledged } = options;
  const params = [userId];
  let whereClause = 'WHERE user_id = $1';

  if (acknowledged !== undefined) {
    params.push(acknowledged);
    whereClause += ` AND acknowledged = $${params.length}`;
  }

  const { rows: alerts } = await db.query(
    `SELECT id, alert_type, ip_address, location_country, location_region, location_city, details, created_at, acknowledged
     FROM login_alerts
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM login_alerts ${whereClause}`,
    params
  );

  return { alerts, total: countRows[0]?.total || 0 };
}

/**
 * Acknowledge a login alert.
 * @param {string} alertId - The alert ID
 * @param {string} userId - The user's ID
 */
async function acknowledgeLoginAlert(alertId, userId) {
  await db.query(
    `UPDATE login_alerts SET acknowledged = TRUE, acknowledged_at = NOW()
     WHERE id = $1 AND user_id = $2 AND acknowledged = FALSE`,
    [alertId, userId]
  );
}

/**
 * Get login attempt history for a user.
 * @param {string} userId - The user's ID
 * @param {object} options - Options (limit, offset)
 * @returns {Promise<{attempts: Array, total: number}>}
 */
async function getUserLoginAttempts(userId, options = {}) {
  const { limit = 50, offset = 0 } = options;

  const { rows: attempts } = await db.query(
    `SELECT id, email, ip_address, user_agent, success, failure_reason, location_country, location_region, location_city, created_at
     FROM login_attempts
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM login_attempts WHERE user_id = $1`,
    [userId]
  );

  return { attempts, total: countRows[0]?.total || 0 };
}

module.exports = {
  generateDeviceFingerprint,
  createUserSession,
  listUserSessions,
  revokeUserSession,
  updateSessionLastSeen,
  recordLoginAttempt,
  checkLoginAnomalies,
  getUserLoginAlerts,
  acknowledgeLoginAlert,
  getUserLoginAttempts,
  MAX_SESSIONS_PER_USER,
};
