const db = require('../config/database');

// Structured milestone evidence checklists (#949). A milestone can define a
// list of evidence items; the creator completes each one when submitting
// work. Completion rows snapshot the label/detail so reviewer-facing
// history stays stable when the template changes later.

const MAX_ITEMS = 20;
const MAX_LABEL_LENGTH = 500;
const MAX_DETAIL_LENGTH = 2000;

/**
 * Validates and normalizes a checklist payload (#949).
 * Returns `{ ok: true, items }` or `{ ok: false, status, error }`.
 */
function validateChecklistInput(input) {
  const items = input?.items;
  if (items === undefined) {
    return { ok: true, items: null }; // absent = leave template unchanged
  }
  if (!Array.isArray(items)) {
    return { ok: false, status: 422, error: 'items must be an array' };
  }
  if (items.length > MAX_ITEMS) {
    return {
      ok: false,
      status: 422,
      error: `a checklist may contain at most ${MAX_ITEMS} items`,
    };
  }

  const normalized = [];
  for (const item of items) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!label) {
      return { ok: false, status: 422, error: 'every checklist item needs a label' };
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return {
        ok: false,
        status: 422,
        error: `checklist labels are limited to ${MAX_LABEL_LENGTH} characters`,
      };
    }
    const detail =
      typeof item?.detail === 'string' && item.detail.trim()
        ? item.detail.trim().slice(0, MAX_DETAIL_LENGTH)
        : null;
    const required = item?.required === false ? false : true;
    const displayOrder = Number.isInteger(item?.display_order)
      ? Math.max(0, item.display_order)
      : normalized.length;
    normalized.push({ label, detail, required, display_order: displayOrder });
  }
  return { ok: true, items: normalized };
}

/**
 * Replaces the checklist template for a milestone (#949). Absent or null
 * `items` leaves the template untouched; an empty array clears it. Item
 * completions cascade-delete with their template items.
 */
async function replaceChecklist(milestoneId, items) {
  if (items === null) return;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM milestone_evidence_checklist_items WHERE milestone_id = $1', [
      milestoneId,
    ]);
    for (const item of items) {
      await client.query(
        `INSERT INTO milestone_evidence_checklist_items
           (milestone_id, label, detail, required, display_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [milestoneId, item.label, item.detail, item.required, item.display_order]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Loads the checklist template for a milestone, ordered (#949).
 */
async function getChecklist(milestoneId) {
  const { rows } = await db.query(
    `SELECT id, milestone_id, label, detail, required, display_order, created_at
     FROM milestone_evidence_checklist_items
     WHERE milestone_id = $1
     ORDER BY display_order ASC, created_at ASC`,
    [milestoneId]
  );
  return rows;
}

/**
 * Records completions for the checklist at submission time (#949).
 *
 * `completedItemIds` must reference items of this milestone. Every required
 * item must be present or the submission is rejected with 422. Labels are
 * snapshotted so later template edits do not rewrite submission history.
 * Concurrent duplicate completions are absorbed by the UNIQUE constraint.
 */
async function recordCompletions(milestoneId, completedItemIds, completedBy) {
  const items = await getChecklist(milestoneId);
  if (!items.length) return { recorded: 0 };

  const requested = new Set(Array.isArray(completedItemIds) ? completedItemIds : []);
  const unknown = [...requested].filter(id => !items.some(item => item.id === id));
  if (unknown.length) {
    return { ok: false, status: 422, error: 'checklist items do not belong to this milestone' };
  }

  const missingRequired = items.filter(item => item.required && !requested.has(item.id));
  if (missingRequired.length) {
    return {
      ok: false,
      status: 422,
      error: `required checklist items not completed: ${missingRequired
        .map(item => item.label)
        .join(', ')}`,
    };
  }

  const client = await db.connect();
  let recorded = 0;
  try {
    await client.query('BEGIN');
    for (const item of items) {
      if (!requested.has(item.id)) continue;
      const result = await client.query(
        `INSERT INTO milestone_evidence_checklist_completions
           (item_id, milestone_id, completed_by, label_snapshot, detail_snapshot)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (item_id) DO NOTHING`,
        [item.id, milestoneId, completedBy || null, item.label, item.detail]
      );
      recorded += result.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, recorded };
}

/**
 * Checklist with completion state for reviewer-facing payloads (#949).
 */
async function getChecklistWithStatus(milestoneId) {
  const items = await getChecklist(milestoneId);
  if (!items.length) return [];
  const { rows } = await db.query(
    `SELECT item_id, completed_by, label_snapshot, detail_snapshot, completed_at
     FROM milestone_evidence_checklist_completions
     WHERE milestone_id = $1`,
    [milestoneId]
  );
  const byItem = new Map(rows.map(row => [row.item_id, row]));
  return items.map(item => {
    const completion = byItem.get(item.id);
    return {
      id: item.id,
      label: item.label,
      detail: item.detail,
      required: item.required,
      display_order: item.display_order,
      completed: Boolean(completion),
      completed_at: completion?.completed_at ?? null,
      label_snapshot: completion?.label_snapshot ?? null,
      detail_snapshot: completion?.detail_snapshot ?? null,
    };
  });
}

/**
 * Whether submission requirements are satisfied: a milestone with a
 * checklist requires every required item completed before submit (#949).
 * Milestones without a checklist are unaffected.
 */
async function isSubmissionSatisfied(milestoneId, completedItemIds) {
  const items = await getChecklist(milestoneId);
  const required = items.filter(item => item.required);
  if (!required.length) return true;
  const requested = new Set(Array.isArray(completedItemIds) ? completedItemIds : []);
  return required.every(item => requested.has(item.id));
}

module.exports = {
  MAX_ITEMS,
  MAX_LABEL_LENGTH,
  MAX_DETAIL_LENGTH,
  validateChecklistInput,
  replaceChecklist,
  getChecklist,
  recordCompletions,
  getChecklistWithStatus,
  isSubmissionSatisfied,
};
