/**
 * Contribution Dedications & Memorial Messages — issue #955
 *
 * Endpoints:
 *   POST   /api/contributions/:contributionId/dedication   – create a dedication
 *   GET    /api/contributions/:contributionId/dedication   – fetch the dedication
 *   PATCH  /api/contributions/:contributionId/dedication   – update the dedication
 *   DELETE /api/contributions/:contributionId/dedication   – remove the dedication
 *   GET    /api/campaigns/:campaignId/dedications          – list public dedications for a campaign
 *
 * Design notes:
 *   - One dedication per contribution (enforced by a UNIQUE index in the DB).
 *   - Only the contributing user may create / update / delete their dedication.
 *   - Public dedications are visible to anyone; private ones only to the
 *     owner, the campaign creator, and admins.
 *   - The honoree_name and message are stripped of HTML at the validation layer
 *     (middleware/validation.js) before they reach this handler.
 *   - All mutations are logged via auditService for compliance.
 *   - Notifications fire asynchronously (setImmediate) so they never delay the
 *     HTTP response.
 */

'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, authenticate } = require('../middleware/auth');
const { dedicationValidation, validateRequest } = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');
const { logAuditEvent } = require('../services/auditService');
const { createNotification } = require('../services/notifications');
const { parsePagination } = require('../utils/pagination');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and authorise access to a contribution.
 *
 * Returns { contribution, campaign } or sends the appropriate error response
 * and returns null (so the caller can return early).
 *
 * @param {string}  contributionId
 * @param {object}  req
 * @param {object}  res
 * @param {object}  [opts]
 * @param {boolean} [opts.requireOwner=false]  Reject if the caller is not the
 *                                              contributing user.
 */
async function resolveContribution(contributionId, req, res, { requireOwner = false } = {}) {
  const { rows } = await db.query(
    `SELECT st.id, st.campaign_id, st.user_id,
            c.title  AS campaign_title,
            c.creator_id AS campaign_creator_id
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     WHERE st.id = $1`,
    [contributionId]
  );

  if (!rows.length) {
    res.status(404).json({ error: 'Contribution not found' });
    return null;
  }

  const contribution = rows[0];

  if (requireOwner) {
    const userId = req.user?.userId;
    const isOwner = contribution.user_id === userId;
    const isAdmin = req.user?.role === 'admin';

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'You are not authorised to modify this dedication' });
      return null;
    }
  }

  return contribution;
}

/**
 * Fetch an existing dedication row or return null if none exists.
 */
async function fetchDedication(contributionId) {
  const { rows } = await db.query(
    `SELECT id, contribution_id, campaign_id, user_id, honoree_name, message,
            dedication_type, is_public, created_at, updated_at
     FROM contribution_dedications
     WHERE contribution_id = $1`,
    [contributionId]
  );
  return rows[0] || null;
}

/**
 * Decide whether the current caller is allowed to see a private dedication.
 * Public dedications are always visible.
 */
function canViewPrivate(user, dedication) {
  if (!user) return false;
  if (user.userId === dedication.user_id) return true;
  if (user.role === 'admin') return true;
  return false;
}

// ---------------------------------------------------------------------------
// POST /api/contributions/:contributionId/dedication
// ---------------------------------------------------------------------------
router.post(
  '/:contributionId/dedication',
  requireAuth,
  dedicationValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { contributionId } = req.params;
    const userId = req.user.userId;

    const contribution = await resolveContribution(contributionId, req, res, {
      requireOwner: true,
    });
    if (!contribution) return;

    // Reject duplicates with a clear, deterministic error.
    const existing = await fetchDedication(contributionId);
    if (existing) {
      return res.status(409).json({
        error: 'A dedication already exists for this contribution',
        code: 'DEDICATION_ALREADY_EXISTS',
        id: existing.id,
      });
    }

    const honoree_name = req.body.honoree_name;
    const message = req.body.message ?? null;
    const dedication_type = req.body.dedication_type ?? 'in_honor_of';
    const is_public =
      req.body.is_public === undefined || req.body.is_public === null
        ? true
        : Boolean(req.body.is_public);

    const { rows } = await db.query(
      `INSERT INTO contribution_dedications
         (contribution_id, campaign_id, user_id, honoree_name, message, dedication_type, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, contribution_id, campaign_id, user_id, honoree_name, message,
                 dedication_type, is_public, created_at, updated_at`,
      [
        contributionId,
        contribution.campaign_id,
        userId,
        honoree_name,
        message,
        dedication_type,
        is_public,
      ]
    );

    const dedication = rows[0];

    // Audit — fire-and-forget, must not fail the response.
    logAuditEvent({
      actorId: userId,
      action: 'dedication_created',
      resourceType: 'contribution_dedication',
      resourceId: dedication.id,
      metadata: {
        contribution_id: contributionId,
        campaign_id: contribution.campaign_id,
        dedication_type,
        is_public,
      },
      req,
    }).catch(err => logger.error('Dedication audit log failed', { error: err.message }));

    // Notify campaign creator (if different from contributor) — async.
    setImmediate(async () => {
      if (contribution.campaign_creator_id && contribution.campaign_creator_id !== userId) {
        createNotification(contribution.campaign_creator_id, {
          type: 'contribution_dedication',
          title: `New dedication on "${contribution.campaign_title}"`,
          body:
            `${dedication_type === 'in_memory_of' ? 'In memory of' : 'In honor of'} ` +
            `${honoree_name}` +
            (message ? `: ${message.slice(0, 120)}` : ''),
          link: `/campaigns/${contribution.campaign_id}`,
        }).catch(err =>
          logger.error('Dedication notification failed', { error: err.message })
        );
      }
    });

    return res.status(201).json(dedication);
  })
);

// ---------------------------------------------------------------------------
// GET /api/contributions/:contributionId/dedication
// ---------------------------------------------------------------------------
router.get(
  '/:contributionId/dedication',
  asyncHandler(async (req, res) => {
    const { contributionId } = req.params;

    // Optional authentication — private dedications need it.
    try {
      await authenticate(req);
    } catch {
      // anonymous caller — proceed without req.user
    }

    const contribution = await resolveContribution(contributionId, req, res);
    if (!contribution) return;

    const dedication = await fetchDedication(contributionId);

    if (!dedication) {
      return res.status(404).json({ error: 'No dedication found for this contribution' });
    }

    if (!dedication.is_public && !canViewPrivate(req.user, dedication)) {
      return res.status(403).json({ error: 'This dedication is private' });
    }

    return res.json(dedication);
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/contributions/:contributionId/dedication
// ---------------------------------------------------------------------------
router.patch(
  '/:contributionId/dedication',
  requireAuth,
  dedicationValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { contributionId } = req.params;
    const userId = req.user.userId;

    const contribution = await resolveContribution(contributionId, req, res, {
      requireOwner: true,
    });
    if (!contribution) return;

    const existing = await fetchDedication(contributionId);
    if (!existing) {
      return res.status(404).json({ error: 'No dedication found for this contribution' });
    }

    // Ownership check on the dedication row itself (admin may bypass).
    if (existing.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You are not authorised to modify this dedication' });
    }

    // Merge: only override fields that were explicitly sent.
    const honoree_name =
      req.body.honoree_name !== undefined ? req.body.honoree_name : existing.honoree_name;
    const message =
      req.body.message !== undefined ? (req.body.message ?? null) : existing.message;
    const dedication_type =
      req.body.dedication_type !== undefined ? req.body.dedication_type : existing.dedication_type;
    const is_public =
      req.body.is_public !== undefined ? Boolean(req.body.is_public) : existing.is_public;

    const { rows } = await db.query(
      `UPDATE contribution_dedications
       SET honoree_name    = $1,
           message         = $2,
           dedication_type = $3,
           is_public       = $4,
           updated_at      = NOW()
       WHERE id = $5
       RETURNING id, contribution_id, campaign_id, user_id, honoree_name, message,
                 dedication_type, is_public, created_at, updated_at`,
      [honoree_name, message, dedication_type, is_public, existing.id]
    );

    logAuditEvent({
      actorId: userId,
      action: 'dedication_updated',
      resourceType: 'contribution_dedication',
      resourceId: existing.id,
      metadata: {
        contribution_id: contributionId,
        campaign_id: contribution.campaign_id,
        dedication_type,
        is_public,
      },
      req,
    }).catch(err => logger.error('Dedication audit log failed', { error: err.message }));

    return res.json(rows[0]);
  })
);

// ---------------------------------------------------------------------------
// DELETE /api/contributions/:contributionId/dedication
// ---------------------------------------------------------------------------
router.delete(
  '/:contributionId/dedication',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { contributionId } = req.params;
    const userId = req.user.userId;

    const contribution = await resolveContribution(contributionId, req, res, {
      requireOwner: true,
    });
    if (!contribution) return;

    const existing = await fetchDedication(contributionId);
    if (!existing) {
      return res.status(404).json({ error: 'No dedication found for this contribution' });
    }

    if (existing.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You are not authorised to delete this dedication' });
    }

    await db.query('DELETE FROM contribution_dedications WHERE id = $1', [existing.id]);

    logAuditEvent({
      actorId: userId,
      action: 'dedication_deleted',
      resourceType: 'contribution_dedication',
      resourceId: existing.id,
      metadata: { contribution_id: contributionId, campaign_id: contribution.campaign_id },
      req,
    }).catch(err => logger.error('Dedication audit log failed', { error: err.message }));

    return res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// GET /api/campaigns/:campaignId/dedications
// Mounted under /api/campaigns so the path seen by this router is /:campaignId/dedications
// ---------------------------------------------------------------------------
router.get(
  '/:campaignId/dedications',
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;

    // Optional auth to allow creators/admins to see private dedications too.
    try {
      await authenticate(req);
    } catch {
      // anonymous — only public dedications returned
    }

    const { rows: campaigns } = await db.query('SELECT id, creator_id FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (!campaigns.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaigns[0];
    const userId = req.user?.userId || null;
    const canSeePrivate =
      req.user && (userId === campaign.creator_id || req.user.role === 'admin');

    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

    // Count
    const countParams = canSeePrivate ? [campaignId] : [campaignId];
    const privateFilter = canSeePrivate ? '' : 'AND cd.is_public = TRUE';

    const countResult = await db.query(
      `SELECT COUNT(*) AS total
       FROM contribution_dedications cd
       WHERE cd.campaign_id = $1 ${privateFilter}`,
      countParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Data
    const { rows } = await db.query(
      `SELECT cd.id, cd.contribution_id, cd.campaign_id, cd.honoree_name, cd.message,
              cd.dedication_type, cd.is_public, cd.created_at,
              u.name AS contributor_name
       FROM contribution_dedications cd
       LEFT JOIN users u ON u.id = cd.user_id
       WHERE cd.campaign_id = $1 ${privateFilter}
       ORDER BY cd.created_at DESC
       LIMIT $2 OFFSET $3`,
      [campaignId, limit, offset]
    );

    return res.json({ data: rows, total, limit, offset });
  })
);

module.exports = router;
