const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { queryAuditLogs, queryAllForExport, buildExportCsv } = require('../services/auditService');
const db = require('../config/database');
const { verifyChain, HASH_VERSION } = require('../lib/auditHash');

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
    res.json(result);
  })
);

/**
 * Verify the tamper-evident hash chain for audit events.
 *
 * Optional filters: `dateFrom`, `dateTo`, `limit`. Rows are always ordered
 * by `chain_se` ascending so the chain is verified in the order it was
 * written. Rows written before the hash chain existed (NULL event_hash)
 * are skipped.
 */
router.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const params = [];
    const where = ['event_hash IS NOT NULL'];

    if (req.query.dateFrom) {
      params.push(req.query.dateFrom);
      where.push(`created_at >= ${
        '$' + params.length
      }`);
    }
    if (req.query.dateTo) {
      params.push(req.query.dateTo);
      where.push(`created_at <= ${'$' + params.length}`);
    }

    const rawLimit = req.query.limit ? Number(req.query.limit) : 5000;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50000) : 5000;
    params.push(limit);

    const { rows } = await db.query(
      `SELECT id, actor_id, action, resource_type, resource_id,
              correlation_id, source, metadata, created_at,
              event_hash, prev_hash, chain_seq, hash_version
         FROM audit_logs
        WHERE ${where.join(' AND ')}
        ORDER BY chain_sep ASC
        LIMIT ${params.length}`,
      params
    );

    const result = verifyChain(rows);
    res.json({
      ...result,
      hash_version: HASH_VERSION,
      rows_considered: rows.length,
    });
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

    if (format === 'csv') {
      res.send(buildExportCsv(rows));
    } else {
      res.send(JSON.stringify({ audit_logs: rows }, null, 2));
    }
  })
);

module.exports = router;
