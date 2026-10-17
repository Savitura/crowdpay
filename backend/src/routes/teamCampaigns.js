const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { isUuid } = require('../utils/validation');
const db = require('../config/database');
const logger = require('../config/logger');
const { getTeamPage, addTeamMember, removeTeamMember } = require('../services/teamCampaignService');

// Team fundraising pages under a parent campaign (#952). Mounted at
// /api/campaigns — parent-scope team routes live here so the surface sits
// next to the other per-campaign sub-resources.

/**
 * Shared 422 envelope for manual uuid validation, matching the
 * express-validator error shape used elsewhere in the API.
 */
function invalidUuid(res, field) {
  return res.status(422).json({
    error: 'Validation failed',
    details: [{ field, message: `${field} must be a valid uuid` }],
  });
}

/**
 * Loads the campaign row plus the authenticated user's ownership relation.
 * Ownership = campaign creator, or platform admin.
 */
async function loadCampaignWithAccess(campaignId, user) {
  const { rows } = await db.query('SELECT id, creator_id, title FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  const campaign = rows[0];
  if (!campaign) return { campaign: null };
  const isOwner = user.role === 'admin' || campaign.creator_id === user.userId;
  return { campaign, isOwner };
}

/**
 * GET /api/campaigns/:id/team
 *
 * Team page payload for a parent campaign: ordered members with per-member
 * progress plus the parent rollup. Public — mirrors the campaign detail
 * surface (#952).
 */
router.get(
  '/:id/team',
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return invalidUuid(res, 'id');
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const page = await getTeamPage(req.params.id);
    return res.status(200).json(page);
  })
);

/**
 * POST /api/campaigns/:id/team/members
 *
 * Adds a campaign as a team member of the parent. Only the parent's owner
 * (or an admin) may compose a team. Invalid, unauthorized, duplicate, and
 * concurrent requests have deterministic outcomes: 422 invalid uuids, 404
 * unknown campaigns, 403 non-owner, 422 integrity rejections, and idempotent
 * re-adds via upsert.
 */
router.post(
  '/:id/team/members',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return invalidUuid(res, 'id');
    if (!isUuid(req.body?.member_campaign_id)) {
      return invalidUuid(res, 'member_campaign_id');
    }
    if (req.body?.role !== undefined && !['owner', 'member'].includes(req.body.role)) {
      return res.status(422).json({
        error: 'Validation failed',
        details: [{ field: 'role', message: 'role must be owner or member' }],
      });
    }
    if (req.body?.display_order !== undefined && !Number.isInteger(req.body.display_order)) {
      return res.status(422).json({
        error: 'Validation failed',
        details: [
          {
            field: 'display_order',
            message: 'display_order must be a non-negative integer',
          },
        ],
      });
    }

    const { campaign, isOwner } = await loadCampaignWithAccess(req.params.id, req.user);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the campaign owner can manage its team' });
    }

    const result = await addTeamMember(req.params.id, req.body.member_campaign_id, {
      role: req.body.role,
      display_order: req.body.display_order,
      invited_by: req.user.userId,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    logger.info(
      { parentId: req.params.id, memberId: req.body.member_campaign_id },
      'team member added'
    );
    return res.status(201).json(result.member);
  })
);

/**
 * DELETE /api/campaigns/:id/team/members/:memberId
 *
 * Removes a member from the parent's team. Owner-only. Deleting an unknown
 * membership 404s.
 */
router.delete(
  '/:id/team/members/:memberId',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return invalidUuid(res, 'id');
    if (!isUuid(req.params.memberId)) return invalidUuid(res, 'memberId');

    const { campaign, isOwner } = await loadCampaignWithAccess(req.params.id, req.user);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the campaign owner can manage its team' });
    }

    const removed = await removeTeamMember(req.params.id, req.params.memberId);
    if (!removed) {
      return res.status(404).json({ error: 'Team member not found' });
    }
    return res.status(204).send();
  })
);

module.exports = router;
