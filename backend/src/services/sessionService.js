const db = require('../config/database');
const crypto = require('crypto');

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
 * Get location info from IP address (stub - would integrate with GeoIP service).
 * @param {string} _ip - IP address (unused in stub)
 * @returns {Promise<{country: string|null, city: string|null}>}
 */
async function getLocationFromIp(_ip) {
  // In production, this would integrate with a GeoIP service like MaxMind
  // For now, return null values
  return { country: null, city: null };
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
  const { country, city } = await getLocationFromIp(ip);

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
     (user_id, refresh_token_id, device_fingerprint, ip_address, user_agent, location_country, location_city)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, device_fingerprint, ip_address, user_agent, location_country, location_city, created_at, last_seen_at`,
    [userId, refreshTokenId, deviceFingerprint, ip, userAgent, country, city]
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
    `SELECT id, device_fingerprint, ip_address, user_agent, location_country, location_city,
            created_at, last_seen_at
     FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY last_seen_at DESC`,
    [userId]
  );

  return rows.map(session => ({
    id: session.id,
    device: session.device_fingerprint ? `Device ${session.device_fingerprint.substring(0, 8)}` : 'Unknown Device',
    location: session.location_city && session.location_country
      ? `${session.location_city}, ${session.location_country}`
      : session.ip_address || 'Unknown Location',
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
    locationCity,
  } = options;

  await db.query(
    `INSERT INTO login_attempts
     (user_id, email, ip_address, user_agent, device_fingerprint, success, failure_reason, location_country, location_city)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, email, ip, userAgent, deviceFingerprint, success, failureReason, locationCountry, locationCity]
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
  const { country, city } = await getLocationFromIp(ip);

  const alerts = [];

  // Check for new device
  const { rows: existingDevices } = await db.query(
    `SELECT 1 FROM user_sessions WHERE user_id = $1 AND device_fingerprint = $2 AND revoked_at IS NULL`,
    [userId, deviceFingerprint]
  );

  if (existingDevices.length === 0) {
    await db.query(
      `INSERT INTO login_alerts
       (user_id, alert_type, ip_address, device_fingerprint, location_country, location_city, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, 'new_device', ip, deviceFingerprint, country, city, JSON.stringify({ userAgent })]
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
         (user_id, alert_type, ip_address, device_fingerprint, location_country, location_city, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, 'new_location', ip, deviceFingerprint, country, city, JSON.stringify({ userAgent })]
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
    `SELECT id, alert_type, ip_address, location_country, location_city, details, created_at, acknowledged
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
    `SELECT id, email, ip_address, user_agent, success, failure_reason, location_country, location_city, created_at
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