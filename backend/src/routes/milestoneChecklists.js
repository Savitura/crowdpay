const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const db = require('../config/database');
const logger = require('../config/logger');
const {
  validateChecklistInput,
  replaceChecklist,
  getChecklistWithStatus,
  recordCompletions,
} = require('../services/milestoneChecklistService');

// Structured milestone evidence checklists (#949). Mounted at /api/milestones
// next to the milestone resource so the checklist surface sits with its
// parent aggregate.

/**
 * Loads a milestone row with its campaign creator for ownership checks.
 */
async function loadMilestoneWithAccess(milestoneId, user) {
  const { rows } = await db.query(
    `SELECT m.id, m.campaign_id, m.status, c.creator_id
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.id = $1`,
    [milestoneId]
  );
  const milestone = rows[0];
  if (!milestone) return { milestone: null };
  const isOwner = user.role === 'admin' || milestone.creator_id === user.userId;
  return { milestone, isOwner };
}

/**
 * GET /api/milestones/:id/checklist
 *
 * Checklist template with per-item completion status (public read).
 */
router.get(
  '/:id/checklist',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT id FROM milestones WHERE id = $1', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    const checklist = await getChecklistWithStatus(req.params.id);
    return res.status(200).json({ checklist });
  })
);

/**
 * PUT /api/milestones/:id/checklist
 *
 * Replaces the checklist template. Creator/admin only. Rejected with 409
 * while the milestone is pending_review/released so submitted evidence
 * is not silently re-scoped mid-review.
 */
router.put(
  '/:id/checklist',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    const { milestone, isOwner } = await loadMilestoneWithAccess(req.params.id, req.user);
    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    if (!isOwner) {
      return res.status(403).json({
        error: 'Only the campaign owner can manage its milestone checklist',
      });
    }
    if (['pending_review', 'released'].includes(milestone.status)) {
      return res.status(409).json({
        error: `The checklist cannot be changed while the milestone is "${milestone.status}"`,
      });
    }

    const parsed = validateChecklistInput(req.body || {});
    if (!parsed.ok) {
      return res.status(parsed.status).json({ error: parsed.error });
    }
    await replaceChecklist(req.params.id, parsed.items);
    logger.info({ milestoneId: req.params.id }, 'milestone checklist updated');
    const checklist = await getChecklistWithStatus(req.params.id);
    return res.status(200).json({ checklist });
  })
);

/**
 * POST /api/milestones/:id/checklist/complete
 *
 * Records checklist completions at submission time. Owner only; every
 * required item must be included or the request is rejected with 422.
 * Idempotent: re-completing an item does not duplicate the row.
 */
router.post(
  '/:id/checklist/complete',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    const { milestone, isOwner } = await loadMilestoneWithAccess(req.params.id, req.user);
    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    if (!isOwner) {
      return res.status(403).json({
        error: 'Only the campaign owner can complete its milestone checklist',
      });
    }

    const itemIds = req.body?.completed_item_ids;
    if (!Array.isArray(itemIds)) {
      return res
        .status(422)
        .json({ error: 'completed_item_ids must be an array of checklist item ids' });
    }

    const result = await recordCompletions(req.params.id, itemIds, req.user.userId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    const checklist = await getChecklistWithStatus(req.params.id);
    return res.status(200).json({ recorded: result.recorded, checklist });
  })
);

module.exports = router;
