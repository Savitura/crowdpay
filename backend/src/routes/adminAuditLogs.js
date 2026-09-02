const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  queryAuditLogs,
  queryAllForExport,
  buildExportCsv,
} = require('../services/auditService');

router.use(requireAuth, requireAdmin);

function safeExportName(ext) {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  return `audit-logs-${now}.${ext}`;
}

/**
 * @openapi
 * /api/admin/audit-logs:
 *   get:
 *     summary: List audit log entries
 *     description: >-
 *       Returns paginated audit log entries, filterable by actor (email or id),
 *       action, resource_type, and date range.
 *     parameters:
 *       - in: query
 *         name: actor
 *         schema: { type: string }
 *       - in: query
 *         name: action
 *         schema: { type: string }
 *       - in: query
 *         name: resource_type
 *         schema: { type: string }
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 */
router.get('/audit-logs', asyncHandler(async (req, res) => {
  const result = await queryAuditLogs({
    actor: req.query.actor,
    action: req.query.action,
    resourceType: req.query.resource_type,
    startDate: req.query.start_date,
    endDate: req.query.end_date,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json(result);
}));

function buildFilteredExport(builder) {
  return asyncHandler(async (req, res) => {
    const filters = {
      actor: req.query.actor,
      action: req.query.action,
      resourceType: req.query.resource_type,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
    };
    const rows = await queryAllForExport(filters);
    res.setHeader('Cache-Control', 'no-store');
    builder(res, rows);
  });
}

/**
 * @openapi
 * /api/admin/audit-logs/export.csv:
 *   get:
 *     summary: Export audit log entries as CSV
 */
router.get(
  '/audit-logs/export.csv',
  buildFilteredExport((res, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeExportName('csv')}"`);
    res.send(buildExportCsv(rows));
  })
);

/**
 * @openapi
 * /api/admin/audit-logs/export.json:
 *   get:
 *     summary: Export audit log entries as JSON
 */
router.get(
  '/audit-logs/export.json',
  buildFilteredExport((res, rows) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeExportName('json')}"`);
    res.send(JSON.stringify({ audit_logs: rows }, null, 2));
  })
);

module.exports = router;
