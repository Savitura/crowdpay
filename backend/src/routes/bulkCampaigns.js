const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  getCsvTemplate,
  parseCsv,
  validateAllRows,
  createImportJob,
  getImportJob,
} = require('../services/bulkCampaignService');

// Rate limiter for bulk campaign uploads: max 10 imports per hour per user
const bulkImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req),
  message: { error: 'Too many bulk import requests. Please try again later.' },
});

/**
 * @openapi
 * /api/campaigns/bulk/template:
 *   get:
 *     tags: [Campaigns]
 *     summary: Download CSV template for bulk campaign creation
 */
router.get('/bulk/template', (_req, res) => {
  const csv = getCsvTemplate();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="campaigns_bulk_template.csv"');
  res.status(200).send(csv);
});

/**
 * @openapi
 * /api/campaigns/bulk/validate:
 *   post:
 *     tags: [Campaigns]
 *     summary: Pre-validate a CSV file before bulk campaign import
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/bulk/validate',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    let csvContent = '';
    if (typeof req.body === 'string') {
      csvContent = req.body;
    } else if (req.body && typeof req.body.csv === 'string') {
      csvContent = req.body.csv;
    } else if (req.body && Array.isArray(req.body.rows)) {
      const report = validateAllRows(req.body.rows);
      return res.json(report);
    } else {
      return res.status(400).json({ error: 'Please provide CSV content in the request body or rows array' });
    }

    const rows = parseCsv(csvContent);
    if (rows.length === 0) {
      return res.status(422).json({
        valid: false,
        total_rows: 0,
        valid_rows: 0,
        invalid_rows: 0,
        errors: [{ row: 0, field: 'file', reason: 'CSV is empty or missing headers' }],
      });
    }

    const report = validateAllRows(rows);
    res.json(report);
  })
);

/**
 * @openapi
 * /api/campaigns/bulk/import:
 *   post:
 *     tags: [Campaigns]
 *     summary: Initiate asynchronous bulk campaign creation from CSV
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/bulk/import',
  requireAuth,
  requireRole('creator', 'admin'),
  bulkImportLimiter,
  asyncHandler(async (req, res) => {
    let csvContent = '';
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key;

    if (typeof req.body === 'string') {
      csvContent = req.body;
    } else if (req.body && typeof req.body.csv === 'string') {
      csvContent = req.body.csv;
    } else {
      return res.status(400).json({ error: 'Please provide CSV content string in req.body or req.body.csv' });
    }

    const job = await createImportJob({
      userId: req.user.userId,
      csvContent,
      idempotencyKey,
    });

    res.status(202).json({
      job_id: job.id,
      status: job.status,
      total_rows: job.total_rows,
      processed_rows: job.processed_rows,
      created_at: job.created_at,
    });
  })
);

/**
 * @openapi
 * /api/campaigns/bulk/jobs/{jobId}:
 *   get:
 *     tags: [Campaigns]
 *     summary: Check progress and results of a bulk campaign import job
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/bulk/jobs/:jobId',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    const job = await getImportJob(req.params.jobId, req.user.userId);
    res.json(job);
  })
);

module.exports = router;
