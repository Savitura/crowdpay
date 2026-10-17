const asyncHandler = require('../utils/asyncHandler');
const { queryAllForExport } = require('../services/exportService');

function safeExportName(ext) {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  return `audit-logs-${now}.${ext}`;
}

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
