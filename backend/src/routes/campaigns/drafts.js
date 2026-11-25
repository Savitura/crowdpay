// backend/src/routes/campaigns/drafts.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');

function createDraftsRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const auth = deps.auth || require('../../middleware/auth');
  const draftVersionService =
    deps.draftVersionService || require('../../services/campaignDraftVersionService');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth, requireRole } = auth;
  const { requireCampaignMember } = helpers;

  function mapDraftError(err, res) {
    if (err.code === 'DRAFT_VERSION_CONFLICT') {
      return res
        .status(409)
        .json({ error: err.message, code: err.code, current_version: err.currentVersion });
    }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    throw err;
  }

  router.post(
    '/drafts',
    requireAuth,
    requireRole('creator', 'admin'),
    asyncHandler(async (req, res) => {
      const { form_data, step } = req.body;

      if (!form_data || typeof form_data !== 'object') {
        return res.status(400).json({ error: 'form_data is required' });
      }

      const { rows } = await db.query(
        `INSERT INTO campaign_drafts (creator_id, form_data, step, saved_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (creator_id)
     DO UPDATE SET form_data = EXCLUDED.form_data,
                   step = EXCLUDED.step,
                   saved_at = NOW()
     RETURNING id, saved_at`,
        [req.user.userId, JSON.stringify(form_data), step ?? 1]
      );

      res.json(rows[0]);
    })
  );

  router.get(
    '/drafts/my',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT id, form_data, step, saved_at
     FROM campaign_drafts
     WHERE creator_id = $1
     ORDER BY saved_at DESC
     LIMIT 1`,
        [req.user.userId]
      );

      if (!rows.length) return res.status(404).json({ error: 'No draft found' });

      res.json(rows[0]);
    })
  );

  router.delete(
    '/drafts/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `DELETE FROM campaign_drafts
     WHERE id = $1 AND creator_id = $2
     RETURNING id`,
        [req.params.id, req.user.userId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Draft not found' });

      res.json({ message: 'Draft deleted' });
    })
  );

  router.put(
    '/:id/draft',
    requireAuth,
    requireCampaignMember('owner', 'manager', 'editor'),
    asyncHandler(async (req, res) => {
      try {
        const result = await draftVersionService.saveDraft({
          campaignId: req.params.id,
          actorId: req.user.userId,
          fields: req.body || {},
          expectedVersion: req.body?.base_version ?? req.body?.draft_version,
        });
        return res.status(200).json({
          draft_version: result.draftVersion,
          draft_saved_at: result.draftSavedAt,
          material_change: result.materialChange,
        });
      } catch (err) {
        return mapDraftError(err, res);
      }
    })
  );

  // List retained versions (metadata only) for the editor's history panel.

  router.get(
    '/:id/draft/versions',
    requireAuth,
    requireCampaignMember('owner', 'manager', 'editor', 'viewer'),
    asyncHandler(async (req, res) => {
      const versions = await draftVersionService.listVersions({ campaignId: req.params.id });
      return res.json({ versions });
    })
  );

  // Preview a retained version using the stored snapshot.

  router.get(
    '/:id/draft/versions/:versionId',
    requireAuth,
    requireCampaignMember('owner', 'manager', 'editor', 'viewer'),
    asyncHandler(async (req, res) => {
      const version = await draftVersionService.getVersion({
        campaignId: req.params.id,
        versionId: req.params.versionId,
      });
      if (!version) return res.status(404).json({ error: 'Draft version not found' });
      return res.json(version);
    })
  );

  // Restore a retained version. Creates a new current version; history is kept.

  router.post(
    '/:id/draft/versions/:versionId/restore',
    requireAuth,
    requireCampaignMember('owner', 'manager', 'editor'),
    asyncHandler(async (req, res) => {
      try {
        const result = await draftVersionService.restoreVersion({
          campaignId: req.params.id,
          versionId: req.params.versionId,
          actorId: req.user.userId,
          expectedVersion: req.body?.base_version ?? req.body?.draft_version,
        });
        return res.json({
          draft_version: result.draftVersion,
          restored_from: result.restoredFrom,
          material_change: result.materialChange,
        });
      } catch (err) {
        return mapDraftError(err, res);
      }
    })
  );

  return router;
}

module.exports = createDraftsRouter;
module.exports.createDraftsRouter = createDraftsRouter;
