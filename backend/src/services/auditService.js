const db = require('../config/database');
const logger = require('../config/logger');

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'apiKey',
  'privateKey',
  'seed',
  'mnemonic',
  'otp',
  'totp',
]);

function sanitizeMetadata(metadata) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== 'object') return metadata;

  const sanitized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeMetadata(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Write an append-only audit log entry.
 * No update or delete path exists by design.
 */
async function logAuditEvent({ actorId, action, resourceType, resourceId, ip, userAgent, metadata = {} }) {
  const safeMetadata = sanitizeMetadata(metadata);

  try {
    await db.query(
      `INSERT INTO security_audit_log (user_id, event_type, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId || null, action, ip || null, userAgent || null, JSON.stringify(safeMetadata)],
    );
  } catch (err) {
    logger.error('Failed to write audit log', { actorId, action, error: err.message });
  }
}

function buildAuditQuery(filters) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (filters.actor) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(filters.actor);
  }

  if (filters.action) {
    conditions.push(`event_type ILIKE $${paramIndex++}`);
    params.push(`%${filters.action}%`);
  }

  if (filters.resourceType) {
    // event_type already encodes the resource type, so we match loosely
    conditions.push(`event_type ILIKE $${paramIndex++}`);
    params.push(`%${filters.resourceType}%`);
  }

  if (filters.dateFrom) {
    conditions.push(`created_at >= $${paramIndex++}`);
    params.push(new Date(filters.dateFrom).toISOString());
  }

  if (filters.dateTo) {
    conditions.push(`created_at <= $${paramIndex++}`);
    params.push(new Date(filters.dateTo).toISOString());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, paramIndex };
}

async function listAuditLogs(filters, { limit = 50, offset = 0 } = {}) {
  const { where, params } = buildAuditQuery(filters);

  const countResult = await db.query(
    `SELECT COUNT(*) FROM security_audit_log ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await db.query(
    `SELECT id, user_id AS actor_id, event_type AS action, ip_address, user_agent, metadata, created_at
     FROM security_audit_log
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    total,
    limit,
    offset,
    items: dataResult.rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    })),
  };
}

function rowsToCsv(rows) {
  const headers = ['id', 'actor_id', 'action', 'ip_address', 'user_agent', 'metadata', 'created_at'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => {
      const val = row[h];
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(','));
  }
  return lines.join('\n');
}

async function exportAuditLogs(filters, format = 'json') {
  const { where, params } = buildAuditQuery(filters);

  const result = await db.query(
    `SELECT id, user_id AS actor_id, event_type AS action, ip_address, user_agent, metadata, created_at
     FROM security_audit_log
     ${where}
     ORDER BY created_at DESC`,
    params,
  );

  const rows = result.rows.map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));

  if (format === 'csv') {
    return { contentType: 'text/csv', body: rowsToCsv(rows) };
  }
  return { contentType: 'application/json', body: JSON.stringify(rows, null, 2) };
}

module.exports = {
  logAuditEvent,
  listAuditLogs,
  exportAuditLogs,
};
