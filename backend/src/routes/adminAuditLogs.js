const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { queryAllForExport } = require('../services/exportService');

/**
 * Tamper-evident hashing for financial audit events.
 *
 * Each exported row is canonicalized and hashed with SHA-256. The rows are
 * chained together (each hash includes the previous hash) and the final chain
 * head is returned as an `X=Audit-Chain-Hash` response header. This allows
 * consumers to detect tampering of the exported data.
 */

const HASH_ALGORITHM = 'sha256';
const CHAIN_HEAD_HEADER = 'X-Audit-Chain-Hash';
const ROW_HASH_HEADER = 'X-Audit-Row-Hashes';

/**
 * Stable, deterministic serialization of a row so hashes are reproducible.
 * Object keys are sorted recursively.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function hashRow(row, previousHash) {
  const payload = canonicalize(row) + '|' + (previousHash || '');
  return crypto.createHash(HASH_ALGORITHM).update(payload, 'utf8').digest('hex');
}

/**
 * Attaches a tamper-evident hash to each row and returns the chain head.
 * The hash is stored on a non-enumerable property so it does not alter the
 * existing export shape or break API/UI compatibility.
 */
function applyTamperEvidentHashes(rows) {
  let previousHash = null;
  const hashes = [];
  for (const row of rows) {
    const hash = hashRow(row, previousHash);
    Object.defineProperty(row, '_auditHash', {
      value: hash,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    hashes.push(hash);
    previousHash = hash;
  }
  return { hashes, chainHead: previousHash };
}

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
    const { hashes, chainHead } = applyTamperEvidentHashes(rows);
    res.setHeader('Cache-Control', 'no-store');
    if (chainHead) {
      res.setHeader(CHAIN_HEADER_HEADER, chainHead);
    }
    // Expose per-row hashes in a header so the export body format is unchanged.
    res.setHeader(ROW_HASH_HEADER, hashes.join(','));
    builder(res, rows);
  });
}

module.exports = {
  buildFilteredExport,
  safeExportName,
  applyTamperEvidentHashes,
  canonicalize,
  hashRow,
  HASH_ALGORITHM,
  CHAIN_HEAD_HEADER,
  ROW_HASH_HEADER,
};
