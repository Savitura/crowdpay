const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { queryAuditLogs, queryAllForExport, buildExportCsv } = require('../services/auditService');

/**
 * Audit log retention policy
 * ---------------------------
 * Audit logs are retained for a fixed period, documented here so that operators,
 * auditors and privacy reviewers have a single authoritative reference. The
 * retention window is enforced by the audit service/storage layer (scheduled purge
 * job); this route layer does not delete data, but it exposes the policy in the
 * responses so consumers can reason about the available history.
 *
 * - Audit logs: retained for 365 days from event creation, then purged.
 * - Exports: contain only data still within the retention window. Exported files
 * are sensitive; they must be stored and transmitted under the same access
 * controls as the source logs and deleted once no longer needed.
 *
 * Related retention periods (documented for completeness, enforced elsewhere):
 * - Sessions: expire after the idle/absolute session timeout configured in the auth
 * layer, and expired session records are purged by the session cleanup job.
 * - Notifications: retained for 90 days after creation, then purged.
 */
const AUDIT_LOG_RETENTION_DAYS = 365;

router.use(requireAuth, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await queryAuditLogs({
      actor: req.query.actor,
      action: req.query.action,
      resourceType: req.query.resourceType,
      correlationId: req.query.correlationId,
      source: req.query.source,
      startDate: req.query.dateFrom,
      endDate: req.query.dateTo,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ ...result, retentionDays: AUDIT_LOG_RETENTION_DAYS });
  })
);

router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const filters = {
      actor: req.query.actor,
      action: req.query.action,
      resourceType: req.query.resourceType,
      correlationId: req.query.correlationId,
      source: req.query.source,
      startDate: req.query.dateFrom,
      endDate: req.query.dateTo,
    };

    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const rows = await queryAllForExport(filters);

    const ext = format === 'csv' ? 'csv' : 'json';
    const contentType =
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'csv') {
      res.send(buildExportCsv(rows));
    } else {
      res.send(
        JSON.stringify(
          { audit_logs: rows, retention_days: AUDIT_LOG_RETENTION_DAYS },
          null,
          2
        )
      );
    }
  })
);

module.exports = router;
module.exports.AUDIT_LOG_RETENTION_DAYS = AUDIT_LOG_RETENTION_DAYS;
