// backend/src/routes/campaigns/updates.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { parsePagination } = require('../../utils/pagination');
const { stripHtml } = require('../../lib/sanitize');

function createUpdatesRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const auth = deps.auth || require('../../middleware/auth');
  const validation = deps.validation || require('../../middleware/validation');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth, optionalAuth } = auth;
  const { createCampaignUpdateValidation, validateRequest } = validation;
  const { requireCampaignMember } = helpers;

  router.get(
    '/:id/updates',
    asyncHandler(async (req, res) => {
      const { limit, offset } = parsePagination(req.query, { limit: 10, max: 50 });
      const { rows } = await db.query(
        `SELECT cu.id, cu.campaign_id, cu.author_id, cu.title, cu.body, cu.created_at, u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC
     LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      );
      res.json(rows);
    })
  );

  router.post(
    '/:id/updates',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    createCampaignUpdateValidation,
    validateRequest,
    asyncHandler(async (req, res) => {
      const { title, body } = req.body;

      const { rows } = await db.query(
        `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, campaign_id, author_id, title, body, created_at`,
        [req.params.id, req.user.userId, title.trim(), body.trim()]
      );
      res.status(201).json(rows[0]);
    })
  );

  // POST /campaigns/:id/members/invite - owner/manager invites by email (7-day token)

  return router;
}

module.exports = createUpdatesRouter;
module.exports.createUpdatesRouter = createUpdatesRouter;
