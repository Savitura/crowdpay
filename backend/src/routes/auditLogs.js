const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { listAuditLogs, exportAuditLogs } = require('../services/auditService');

router.use(requireAuth, requireRole('admin'));

/**
 * @openapi
 * /api/admin/audit-logs:
 *   get:
 *     summary: List audit logs with filters and pagination
 */
router.get('/', asyncHandler(async (req, res) => {
  const filters = {
    actor: req.query.actor || null,
    action: req.query.action || null,
    resourceType: req.query.resourceType || null,
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
  };

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);

  const result = await listAuditLogs(filters, { limit, offset });
  res.json(result);
}));

/**
 * @openapi
 * /api/admin/audit-logs/export:
 *   get:
 *     summary: Export filtered audit logs as CSV or JSON
 */
router.get('/export', asyncHandler(async (req, res) => {
  const filters = {
    actor: req.query.actor || null,
    action: req.query.action || null,
    resourceType: req.query.resourceType || null,
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
  };

  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const { contentType, body } = await exportAuditLogs(filters, format);

  const ext = format === 'csv' ? 'csv' : 'json';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs.${ext}"`);
  res.send(body);
}));

module.exports = router;
