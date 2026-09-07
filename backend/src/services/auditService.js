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
const { parsePagination } = require('../utils/pagination');

const MAX_AUDIT_LIMIT = 200;

const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|private.?key|seed|token|authorization|cookie|totp)/i;
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const REDACTED = '[REDACTED]';

const EXPORT_COLUMNS = [
  'id',
  'actor_id',
  'actor_email',
  'action',
  'resource_type',
  'resource_id',
  'ip_address',
  'user_agent',
  'metadata',
  'created_at',
];

/**
 * Recursively scrub sensitive keys/value patterns from audit metadata before
 * persistence so that passwords, secrets, Stellar private keys, tokens, etc.
 * are never stored in the audit log.
 */
function sanitizeMetadata(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return STELLAR_SECRET_PATTERN.test(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadata(entry, seen));
  }

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeMetadata(entry, seen);
  }
  return out;
}

/**
 * Record an append-only audit event.
 *
 * @param {object} payload
 * @param {string|null|undefined} payload.actorId     User performing the action
 * @param {string} payload.action                     Action verb, e.g. 'login', 'refund_issued'
 * @param {string} payload.resourceType               Type of resource affected, e.g. 'user', 'campaign', 'refund'
 * @param {string|number|null} [payload.resourceId]   Resource identifier
 * @param {object} [payload.metadata]                 Contextual data (sanitized before persistence)
 */
async function logAuditEvent({
  actorId = null,
  action,
  resourceType,
  resourceId = null,
  metadata = {},
  req = null,
}) {
  const ip = req?.ip || req?.connection?.remoteAddress || null;
  const userAgent = req?.headers?.['user-agent'] || null;

  const safeMetadata = sanitizeMetadata(metadata);

  const { rows } = await db.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id, actor_id, action, resource_type, resource_id, ip_address, user_agent, metadata, created_at`,
    [actorId, action, resourceType, resourceId !== null && resourceId !== undefined ? String(resourceId) : null, ip, userAgent, JSON.stringify(safeMetadata)]
  );

  logger.info('audit_log_event', {
    auditId: rows[0].id,
    action,
    resource_type: resourceType,
    actor_id: actorId,
  });

  return rows[0];
}

/**
 * Build the WHERE clause and bind params for audit log filtering.
 */
function buildWhereClause({ actor, action, resourceType, startDate, endDate }) {
  const conditions = [];
  const params = [];

  if (actor) {
    params.push(`%${actor}%`);
    params.push(actor);
    conditions.push(`(u.email ILIKE $${params.length - 1} OR a.actor_id::text = $${params.length})`);
  }

  if (action) {
    params.push(action);
    conditions.push(`a.action = $${params.length}`);
  }

  if (resourceType) {
    params.push(resourceType);
    conditions.push(`a.resource_type = $${params.length}`);
  }

  if (startDate) {
    const start = new Date(startDate);
    if (!Number.isNaN(start.getTime())) {
      params.push(start.toISOString());
      conditions.push(`a.created_at >= $${params.length}`);
    }
  }

  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      params.push(end.toISOString());
      conditions.push(`a.created_at <= $${params.length}`);
    }
  }

  return { conditions, params };
}

const COUNT_SQL = (where) => `
  SELECT COUNT(*)::int AS total
    FROM audit_logs a
   ${where}`;

const LIST_SQL = (where) => `
  SELECT a.id,
         a.actor_id,
         u.email AS actor_email,
         a.action,
         a.resource_type,
         a.resource_id,
         a.ip_address,
         a.user_agent,
         a.metadata,
         a.created_at
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
   ${where}
   ORDER BY a.created_at DESC, a.id DESC
   LIMIT $${placeholdersAfter(where, 1)} OFFSET $${placeholdersAfter(where, 2)}`;

function placeholdersAfter(where, n) {
  const count = (where.match(/\$\d+/g) || []).length;
  return count + n;
}

async function queryAuditLogs(filters) {
  const { limit, offset } = parsePagination(filters, { limit: 50, max: MAX_AUDIT_LIMIT });
  const { conditions, params } = buildWhereClause(filters);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await db.query(COUNT_SQL(where), params);
  const total = countRes.rows[0]?.total ?? 0;

  const dataRes = await db.query(LIST_SQL(where), [...params, limit, offset]);
  return { data: dataRes.rows, total, limit, offset };
}

function neutralizeFormulaPrefix(value) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = neutralizeFormulaPrefix(raw);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(values) {
  return `${values.map(csvCell).join(',')}\n`;
}

const CSV_HEADER = ['actor', 'action', 'resource_type', 'resource_id', 'ip_address', 'user_agent', 'metadata', 'created_at'];

function exportCell(value) {
  if (value && typeof value === 'object') value = JSON.stringify(value);
  if (value instanceof Date) value = value.toISOString();
  return value;
}

function buildExportCsv(rows) {
  const lines = [csvRow(CSV_HEADER)];
  for (const row of rows) {
    lines.push(
      csvRow([
        exportCell(row.actor_email),
        exportCell(row.action),
        exportCell(row.resource_type),
        exportCell(row.resource_id),
        exportCell(row.ip_address),
        exportCell(row.user_agent),
        exportCell(row.metadata),
        exportCell(row.created_at),
      ])
    );
  }
  return lines.join('');
}

async function queryAllForExport(filters) {
  const { conditions, params } = buildWhereClause(filters);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT a.id,
            a.actor_id,
            u.email AS actor_email,
            a.action,
            a.resource_type,
            a.resource_id,
            a.ip_address,
            a.user_agent,
            a.metadata,
            a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      ${where}
      ORDER BY a.created_at DESC, a.id DESC`,
    params
  );
  return rows;
}

module.exports = {
  logAuditEvent,
  listAuditLogs,
  exportAuditLogs,
  queryAuditLogs,
  queryAllForExport,
  queryAuditLogsForExport: queryAllForExport,
  sanitizeMetadata,
  buildExportCsv,
  EXPORT_COLUMNS,
  MAX_AUDIT_LIMIT,
};
