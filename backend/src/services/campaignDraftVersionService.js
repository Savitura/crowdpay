'use strict';

/**
 * Campaign draft autosave + recoverable version history (issue #942).
 *
 * Only the editable content fields are snapshotted; wallet keys, secrets,
 * derived/aggregate columns and transient request state (preview tokens,
 * idempotency keys, validation errors) are never retained in a version.
 *
 * Concurrency uses the `campaigns.draft_version` counter: an autosave sends the
 * version it started from and the update only applies when it still matches, so
 * two tabs cannot silently overwrite each other. A mismatch returns a 409 that
 * carries the current version, and both versions remain recoverable.
 */

const db = require('../config/database');

const EDITABLE_DRAFT_FIELDS = Object.freeze([
  'title',
  'description',
  'category',
  'target_amount',
  'deadline',
  'min_contribution',
  'max_contribution',
  'max_per_user',
  'show_backer_amounts',
]);

const VALID_REASONS = Object.freeze(['autosave', 'manual', 'restore']);

const DRAFT_COLUMNS = EDITABLE_DRAFT_FIELDS.join(', ');

function pickDraftSnapshot(source = {}) {
  const snapshot = {};
  for (const field of EDITABLE_DRAFT_FIELDS) {
    if (source !== null && Object.prototype.hasOwnProperty.call(source, field)) {
      snapshot[field] = source[field];
    }
  }
  return snapshot;
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function hasMaterialChange(current = {}, next = {}) {
  return EDITABLE_DRAFT_FIELDS.some(field => {
    if (!Object.prototype.hasOwnProperty.call(next, field)) return false;
    return normalizeValue(current[field]) !== normalizeValue(next[field]);
  });
}

function draftConflictError(currentVersion) {
  const error = new Error(
    'Draft was modified by another session. Reload to get the latest version.'
  );
  error.statusCode = 409;
  error.code = 'DRAFT_VERSION_CONFLICT';
  error.currentVersion = Number(currentVersion);
  return error;
}

function assertNoConflict({ currentVersion, expectedVersion }) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
  if (Number(expectedVersion) !== Number(currentVersion)) {
    throw draftConflictError(currentVersion);
  }
}

function notFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

/**
 * Autosave editable draft fields.
 *
 * @returns {Promise<{draftVersion:number, draftSavedAt:Date, materialChange:boolean}>}
 * @throws 409 when `expectedVersion` does not match the stored `draft_version`
 * @throws 404 when the campaign does not exist
 */
async function saveDraft({
  campaignId,
  actorId,
  fields = {},
  expectedVersion,
  reason = 'autosave',
  forceRecord = false,
  runner = db,
} = {}) {
  const updateFields = pickDraftSnapshot(fields);
  const recordReason = VALID_REASONS.includes(reason) ? reason : 'autosave';

  const client = typeof runner.connect === 'function' ? await runner.connect() : null;
  const query = client || runner;
  const ownsClient = Boolean(client);

  try {
    if (ownsClient) await query.query('BEGIN');

    const { rows } = await query.query(
      `SELECT id, draft_version, ${DRAFT_COLUMNS}
         FROM campaigns
        WHERE id = $1
        FOR UPDATE`,
      [campaignId]
    );
    const current = rows[0];
    if (!current) throw notFoundError('Campaign not found');

    assertNoConflict({ currentVersion: current.draft_version, expectedVersion });

    const materialChange = hasMaterialChange(current, updateFields);

    const sets = ['draft_version = draft_version + 1', 'draft_saved_at = NOW()'];
    const params = [campaignId];
    let index = 2;
    for (const [field, value] of Object.entries(updateFields)) {
      sets.push(`${field} = $${index}`);
      params.push(value);
      index += 1;
    }

    const { rows: updatedRows } = await query.query(
      `UPDATE campaigns
          SET ${sets.join(', ')}
        WHERE id = $1
        RETURNING draft_version, draft_saved_at`,
      params
    );
    const updated = updatedRows[0];

    // Material edits (and explicit restores) are the checkpoints users can
    // recover; a no-op autosave only advances the concurrency counter.
    if (materialChange || forceRecord) {
      const merged = { ...pickDraftSnapshot(current), ...updateFields };
      await query.query(
        `INSERT INTO campaign_draft_versions (campaign_id, author_id, version, reason, snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [campaignId, actorId || null, updated.draft_version, recordReason, JSON.stringify(merged)]
      );
    }

    if (ownsClient) await query.query('COMMIT');

    return {
      draftVersion: Number(updated.draft_version),
      draftSavedAt: updated.draft_saved_at,
      materialChange,
    };
  } catch (error) {
    if (ownsClient) {
      try {
        await query.query('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
    }
    throw error;
  } finally {
    if (ownsClient && typeof query.release === 'function') query.release();
  }
}

async function listVersions({ campaignId, limit = 50, runner = db } = {}) {
  const { rows } = await runner.query(
    `SELECT id, campaign_id, author_id, version, reason, created_at
       FROM campaign_draft_versions
      WHERE campaign_id = $1
      ORDER BY version DESC
      LIMIT $2`,
    [campaignId, limit]
  );
  return rows;
}

async function getVersion({ campaignId, versionId, runner = db } = {}) {
  const { rows } = await runner.query(
    `SELECT id, campaign_id, author_id, version, reason, snapshot, created_at
       FROM campaign_draft_versions
      WHERE campaign_id = $1 AND id = $2`,
    [campaignId, versionId]
  );
  return rows[0] || null;
}

/**
 * Restore a retained version. The restore never deletes history: it applies the
 * snapshot and records a NEW version marked `restore`.
 */
async function restoreVersion({
  campaignId,
  versionId,
  actorId,
  expectedVersion,
  runner = db,
} = {}) {
  const version = await getVersion({ campaignId, versionId, runner });
  if (!version) throw notFoundError('Draft version not found');

  const result = await saveDraft({
    campaignId,
    actorId,
    fields: version.snapshot || {},
    expectedVersion,
    reason: 'restore',
    forceRecord: true,
    runner,
  });

  return { ...result, restoredFrom: version.version, versionId: version.id };
}

module.exports = {
  EDITABLE_DRAFT_FIELDS,
  VALID_REASONS,
  pickDraftSnapshot,
  hasMaterialChange,
  assertNoConflict,
  saveDraft,
  listVersions,
  getVersion,
  restoreVersion,
};
