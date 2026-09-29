const crypto = require('node:crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { Keypair } = require('@stellar/stellar-sdk');
const { MILESTONE_LIMIT } = require('../config/constants');

const SUPPORTED_ASSETS = ['USDC', 'XLM'];

const CSV_HEADER = 'title,description,target_amount,asset_type,deadline,category,cover_image_url,country,min_contribution,max_contribution,milestones,reward_tiers';

const SAMPLE_CSV = `${CSV_HEADER}
"Clean Water Project","Solar-powered well construction",25000,USDC,2027-12-31T23:59:59Z,community,"https://images.unsplash.com/photo-water",US,10,5000,"[{""title"":""Phase 1"",""description"":""Drilling"",""release_percentage"":100}]","[{""title"":""Supporter"",""amount"":50,""description"":""Name on plaque""}]"
"Community Library","Public library resources and computers",15000,USDC,2027-11-30T23:59:59Z,education,"https://images.unsplash.com/photo-library",CA,5,2500,"",""
`;

function getCsvTemplate() {
  return SAMPLE_CSV;
}

/**
 * Robust CSV parser that handles quotes, escaped quotes, commas, and newlines.
 */
function parseCsv(content) {
  if (!content || typeof content !== 'string') return [];
  const lines = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          cell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        cell += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ',') {
        row.push(cell.trim());
        cell = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (nextChar === '\n') i++;
        row.push(cell.trim());
        if (row.some((c) => c !== '')) lines.push(row);
        row = [];
        cell = '';
        i++;
        continue;
      } else if (char === '\n') {
        row.push(cell.trim());
        if (row.some((c) => c !== '')) lines.push(row);
        row = [];
        cell = '';
        i++;
        continue;
      } else {
        cell += char;
        i++;
        continue;
      }
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c !== '')) lines.push(row);
  }

  if (lines.length < 2) return [];

  const headers = lines[0].map((h) => h.toLowerCase().trim());
  const rows = [];

  for (let r = 1; r < lines.length; r++) {
    const values = lines[r];
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[c] !== undefined ? values[c] : '';
    }
    rows.push(obj);
  }

  return rows;
}

/**
 * Validates a single campaign row against platform requirements.
 *
 * @param {Object} row
 * @param {number} rowIndex 1-indexed row number
 * @returns {Array<{row: number, field: string, reason: string}>}
 */
function validateCampaignRow(row, rowIndex) {
  const errors = [];

  // Title validation
  if (!row.title || typeof row.title !== 'string' || !row.title.trim()) {
    errors.push({ row: rowIndex, field: 'title', reason: 'Title is required and cannot be empty' });
  } else if (row.title.trim().length > 120) {
    errors.push({ row: rowIndex, field: 'title', reason: 'Title must be 120 characters or fewer' });
  }

  // Target amount validation
  const targetAmount = Number(row.target_amount);
  if (isNaN(targetAmount) || targetAmount <= 0) {
    errors.push({ row: rowIndex, field: 'target_amount', reason: 'Target amount must be a positive number' });
  }

  // Asset type validation
  const assetType = String(row.asset_type || '').toUpperCase().trim();
  if (!SUPPORTED_ASSETS.includes(assetType)) {
    errors.push({
      row: rowIndex,
      field: 'asset_type',
      reason: `Asset type must be one of: ${SUPPORTED_ASSETS.join(', ')}`,
    });
  }

  // Deadline validation
  if (row.deadline && row.deadline.trim()) {
    const deadlineDate = new Date(row.deadline.trim());
    if (isNaN(deadlineDate.getTime())) {
      errors.push({ row: rowIndex, field: 'deadline', reason: 'Deadline must be a valid date' });
    } else if (deadlineDate.getTime() <= Date.now()) {
      errors.push({ row: rowIndex, field: 'deadline', reason: 'Deadline must be in the future' });
    }
  }

  // Cover image URL validation
  if (row.cover_image_url && row.cover_image_url.trim()) {
    const url = row.cover_image_url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      errors.push({ row: rowIndex, field: 'cover_image_url', reason: 'Cover image URL must start with http:// or https://' });
    }
  }

  // Milestones validation
  if (row.milestones && row.milestones.trim()) {
    try {
      const parsed = typeof row.milestones === 'string' ? JSON.parse(row.milestones) : row.milestones;
      if (!Array.isArray(parsed)) {
        errors.push({ row: rowIndex, field: 'milestones', reason: 'Milestones must be a JSON array' });
      } else {
        if (parsed.length > MILESTONE_LIMIT) {
          errors.push({ row: rowIndex, field: 'milestones', reason: `At most ${MILESTONE_LIMIT} milestones are allowed` });
        }
        let sum = 0;
        for (let m = 0; m < parsed.length; m++) {
          const item = parsed[m];
          if (!item.title || !item.description) {
            errors.push({ row: rowIndex, field: 'milestones', reason: `Milestone ${m + 1} requires title and description` });
          }
          const pct = Number(item.release_percentage);
          if (isNaN(pct) || pct <= 0) {
            errors.push({ row: rowIndex, field: 'milestones', reason: `Milestone ${m + 1} release_percentage must be > 0` });
          } else {
            sum += pct;
          }
        }
        if (parsed.length > 0 && Math.abs(sum - 100) > 0.01) {
          errors.push({ row: rowIndex, field: 'milestones', reason: `Milestone release percentages must sum to 100% (got ${sum}%)` });
        }
      }
    } catch {
      errors.push({ row: rowIndex, field: 'milestones', reason: 'Milestones must be valid JSON' });
    }
  }

  // Reward tiers validation
  if (row.reward_tiers && row.reward_tiers.trim()) {
    try {
      const parsed = typeof row.reward_tiers === 'string' ? JSON.parse(row.reward_tiers) : row.reward_tiers;
      if (!Array.isArray(parsed)) {
        errors.push({ row: rowIndex, field: 'reward_tiers', reason: 'Reward tiers must be a JSON array' });
      } else {
        for (let t = 0; t < parsed.length; t++) {
          const tier = parsed[t];
          if (!tier.title || typeof tier.title !== 'string') {
            errors.push({ row: rowIndex, field: 'reward_tiers', reason: `Reward tier ${t + 1} requires a title` });
          }
          const amt = Number(tier.amount);
          if (isNaN(amt) || amt <= 0) {
            errors.push({ row: rowIndex, field: 'reward_tiers', reason: `Reward tier ${t + 1} amount must be > 0` });
          }
        }
      }
    } catch {
      errors.push({ row: rowIndex, field: 'reward_tiers', reason: 'Reward tiers must be valid JSON' });
    }
  }

  return errors;
}

/**
 * Validates an entire set of parsed rows and returns a comprehensive report.
 */
function validateAllRows(rows) {
  const allErrors = [];
  let validCount = 0;
  let invalidCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const rowErrors = validateCampaignRow(rows[idx], idx + 1);
    if (rowErrors.length > 0) {
      allErrors.push(...rowErrors);
      invalidCount++;
    } else {
      validCount++;
    }
  }

  return {
    valid: allErrors.length === 0,
    total_rows: rows.length,
    valid_rows: validCount,
    invalid_rows: invalidCount,
    errors: allErrors,
  };
}

/**
 * Starts a bulk import background job.
 */
async function createImportJob({ userId, csvContent, idempotencyKey = null }) {
  const contentHash = crypto.createHash('sha256').update(csvContent).digest('hex');

  // Check for duplicate / idempotent submission
  if (idempotencyKey) {
    const { rows: existing } = await db.query(
      'SELECT * FROM bulk_campaign_imports WHERE idempotency_key = $1 AND user_id = $2',
      [idempotencyKey, userId]
    );
    if (existing.length) {
      return existing[0];
    }
  }

  const { rows: existingByHash } = await db.query(
    `SELECT * FROM bulk_campaign_imports
     WHERE content_hash = $1 AND user_id = $2 AND status IN ('processing', 'completed')
       AND created_at >= NOW() - INTERVAL '24 hours'`,
    [contentHash, userId]
  );
  if (existingByHash.length) {
    return existingByHash[0];
  }

  const rows = parseCsv(csvContent);
  if (rows.length === 0) {
    const err = new Error('CSV is empty or contains only headers');
    err.statusCode = 422;
    throw err;
  }

  const validationReport = validateAllRows(rows);

  const { rows: insertedJob } = await db.query(
    `INSERT INTO bulk_campaign_imports
       (user_id, idempotency_key, content_hash, total_rows, status, validation_report)
     VALUES ($1, $2, $3, $4, 'processing', $5::jsonb)
     RETURNING *`,
    [
      userId,
      idempotencyKey || null,
      contentHash,
      rows.length,
      JSON.stringify(validationReport.errors),
    ]
  );

  const job = insertedJob[0];

  // Log in audit log
  await db.query(
    `INSERT INTO audit_logs (action, actor_id, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      'bulk_campaign_import_started',
      userId,
      'bulk_import',
      job.id,
      JSON.stringify({ total_rows: rows.length, content_hash: contentHash }),
    ]
  ).catch(() => {});

  // Run import job asynchronously
  setImmediate(() => {
    executeImportJob(job.id, userId, rows).catch((err) => {
      logger.error('Bulk campaign import background execution failed', {
        jobId: job.id,
        error: err.message,
      });
    });
  });

  return job;
}

/**
 * Executes the bulk campaign import row-by-row atomically.
 */
async function executeImportJob(jobId, userId, rows) {
  let processed = 0;
  let successful = 0;
  let failed = 0;
  const results = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const rowNum = idx + 1;
    const rowErrors = validateCampaignRow(row, rowNum);

    if (rowErrors.length > 0) {
      failed++;
      processed++;
      results.push({
        row: rowNum,
        success: false,
        title: row.title || 'Untitled',
        errors: rowErrors.map((e) => e.reason),
      });
      continue;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const walletKeypair = Keypair.random();
      const walletPublicKey = walletKeypair.publicKey();
      const assetType = (row.asset_type || 'USDC').toUpperCase().trim();
      const targetAmount = Number(row.target_amount).toFixed(7);
      const deadline = row.deadline ? new Date(row.deadline).toISOString() : null;
      const coverImageUrl = row.cover_image_url ? row.cover_image_url.trim() : null;
      const category = row.category ? row.category.trim() : 'general';
      const country = row.country ? row.country.trim().slice(0, 80) : null;
      const minContribution = row.min_contribution ? Number(row.min_contribution).toFixed(7) : null;
      const maxContribution = row.max_contribution ? Number(row.max_contribution).toFixed(7) : null;

      const { rows: campaignRows } = await client.query(
        `INSERT INTO campaigns
           (creator_id, title, description, target_amount, asset_type, deadline,
            cover_image_url, category, country, min_contribution, max_contribution,
            wallet_public_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')
         RETURNING id, title, target_amount, asset_type, status, created_at`,
        [
          userId,
          row.title.trim(),
          row.description ? row.description.trim() : '',
          targetAmount,
          assetType,
          deadline,
          coverImageUrl,
          category,
          country,
          minContribution,
          maxContribution,
          walletPublicKey,
        ]
      );

      const campaign = campaignRows[0];

      // Milestones
      if (row.milestones && row.milestones.trim()) {
        const milestones = typeof row.milestones === 'string' ? JSON.parse(row.milestones) : row.milestones;
        for (let m = 0; m < milestones.length; m++) {
          const item = milestones[m];
          await client.query(
            `INSERT INTO milestones
               (campaign_id, title, description, release_percentage, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [campaign.id, item.title.trim(), item.description.trim(), Number(item.release_percentage).toFixed(4), m]
          );
        }
      }

      // Reward tiers
      if (row.reward_tiers && row.reward_tiers.trim()) {
        const tiers = typeof row.reward_tiers === 'string' ? JSON.parse(row.reward_tiers) : row.reward_tiers;
        for (let t = 0; t < tiers.length; t++) {
          const tier = tiers[t];
          await client.query(
            `INSERT INTO reward_tiers
               (campaign_id, title, description, amount, asset_type, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              campaign.id,
              tier.title.trim(),
              tier.description ? tier.description.trim() : '',
              Number(tier.amount).toFixed(7),
              assetType,
              t,
            ]
          );
        }
      }

      await client.query('COMMIT');
      successful++;
      processed++;
      results.push({
        row: rowNum,
        success: true,
        campaign_id: campaign.id,
        title: campaign.title,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      failed++;
      processed++;
      logger.error('Failed to create campaign in bulk row', { row: rowNum, error: err.message });
      results.push({
        row: rowNum,
        success: false,
        title: row.title || 'Untitled',
        errors: [err.message],
      });
    } finally {
      client.release();
    }
  }

  await db.query(
    `UPDATE bulk_campaign_imports
     SET status = 'completed',
         processed_rows = $1,
         successful_rows = $2,
         failed_rows = $3,
         results = $4::jsonb,
         updated_at = NOW()
     WHERE id = $5`,
    [processed, successful, failed, JSON.stringify(results), jobId]
  );
}

/**
 * Gets details and progress of a bulk import job.
 */
async function getImportJob(jobId, userId) {
  const { rows } = await db.query(
    `SELECT id, user_id, idempotency_key, content_hash, total_rows,
            processed_rows, successful_rows, failed_rows, status,
            validation_report, results, created_at, updated_at
     FROM bulk_campaign_imports
     WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );

  if (!rows.length) {
    const err = new Error('Import job not found');
    err.statusCode = 404;
    throw err;
  }

  return rows[0];
}

module.exports = {
  getCsvTemplate,
  parseCsv,
  validateCampaignRow,
  validateAllRows,
  createImportJob,
  getImportJob,
  executeImportJob,
};
