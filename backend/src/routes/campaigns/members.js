// backend/src/routes/campaigns/members.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { parsePagination } = require('../../utils/pagination');

function createMembersRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const auth = deps.auth || require('../../middleware/auth');
  const emailService = deps.emailService || require('../../services/emailService');
  const campaignInviteService =
    deps.campaignInviteService || require('../../services/campaignInviteService');
  const campaignPermissions = deps.campaignPermissions || require('../../lib/campaignPermissions');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth } = auth;
  const { sendTeamMemberInvitedEmail } = emailService;
  const {
    createCampaignInvite,
    resendCampaignInvite,
    cancelCampaignInvite,
    acceptCampaignInvite,
    countAcceptedOwners,
    resolveUserCampaignRole,
  } = campaignInviteService;
  const {
    isValidRole,
    canEditCampaignContent,
    canViewAnalytics,
    canInviteMembers,
    canManageMembers,
    canChangeRoles,
    canAssignRole,
  } = campaignPermissions;
  const { requireCampaignMember } = helpers;

  router.post(
    '/:id/members/invite',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const { email, role } = req.body;
      if (!email || !role) return res.status(422).json({ error: 'Email and role are required' });
      if (!isValidRole(role)) {
        return res
          .status(422)
          .json({ error: 'Invalid role. Must be owner, manager, editor, or viewer' });
      }
      // Never trust the client: only owners may grant the owner role.
      if (!canAssignRole(req.campaignRole, role)) {
        return res.status(403).json({ error: 'Only an owner can assign the owner role' });
      }

      const { rows: campaignRows } = await db.query('SELECT title FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      const { member } = await createCampaignInvite({
        campaignId: req.params.id,
        email,
        role,
        invitedByUserId: req.user.userId,
        campaignTitle: campaignRows[0]?.title,
      });
      res.status(201).json(member);
    })
  );

  // GET /campaigns/:id/members - team list (owner/manager)

  router.get(
    '/:id/members',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

      const countResult = await db.query(
        'SELECT COUNT(*)::int AS total FROM campaign_members WHERE campaign_id = $1',
        [req.params.id]
      );
      const total = countResult.rows[0].total;

      const { rows } = await db.query(
        `SELECT cm.id, cm.user_id, cm.email, cm.role, cm.accepted_at, cm.created_at,
            cm.invite_expires_at,
            u.name AS user_name
     FROM campaign_members cm
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.campaign_id = $1
     ORDER BY cm.created_at ASC
     LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]
      );
      res.json({ data: rows, total, limit, offset });
    })
  );

  // PATCH /campaigns/:id/members/:userId - change role (owner only)

  router.patch(
    '/:id/members/:userId',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { role } = req.body;
      if (!role || !isValidRole(role)) {
        return res
          .status(422)
          .json({ error: 'Invalid role. Must be owner, manager, editor, or viewer' });
      }

      const { rows } = await db.query(
        `UPDATE campaign_members
     SET role = $1
     WHERE campaign_id = $2 AND user_id = $3 AND accepted_at IS NOT NULL
     RETURNING id, campaign_id, user_id, role, accepted_at`,
        [role, req.params.id, req.params.userId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'Member not found' });
      }

      res.json(rows[0]);
    })
  );

  // POST /campaigns/:id/members/:memberId/resend - resend pending invite

  router.post(
    '/:id/members/:memberId/resend',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      const { rows: campaignRows } = await db.query('SELECT title FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      const { member } = await resendCampaignInvite({
        memberId: req.params.memberId,
        campaignId: req.params.id,
        campaignTitle: campaignRows[0]?.title,
      });
      res.json(member);
    })
  );

  // DELETE /campaigns/:id/members/invites/:memberId - cancel pending invite

  router.delete(
    '/:id/members/invites/:memberId',
    requireAuth,
    requireCampaignMember('owner', 'manager'),
    asyncHandler(async (req, res) => {
      await cancelCampaignInvite({
        memberId: req.params.memberId,
        campaignId: req.params.id,
      });
      res.json({ cancelled: true });
    })
  );

  // DELETE /campaigns/:id/members/:userId - remove member (owner) or leave team

  router.delete(
    '/:id/members/:userId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const memberUserId = req.params.userId;
      const isSelf = String(memberUserId) === String(req.user.userId);

      const actorRole = await resolveUserCampaignRole(
        req.params.id,
        req.user.userId,
        req.user.role === 'admin'
      );

      if (!isSelf && !canManageMembers(actorRole)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const { rows: targetRows } = await db.query(
        `SELECT role, accepted_at FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2`,
        [req.params.id, memberUserId]
      );

      if (!targetRows.length) {
        return res.status(404).json({ error: 'Member not found' });
      }

      if (targetRows[0].role === 'owner' && targetRows[0].accepted_at) {
        const ownerCount = await countAcceptedOwners(req.params.id);
        if (ownerCount <= 1) {
          return res
            .status(409)
            .json({ error: 'Cannot remove the last owner from the campaign team' });
        }
      }

      const { rows } = await db.query(
        `DELETE FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2
     RETURNING id`,
        [req.params.id, memberUserId]
      );

      res.json({ message: 'Member removed successfully', id: rows[0].id });
    })
  );

  // POST /campaigns/:id/members/accept - accept invitation (token in body, legacy)

  router.post(
    '/:id/members/accept',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { token: inviteToken } = req.body;
      if (!inviteToken) return res.status(422).json({ error: 'Invitation token is required' });

      const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [
        req.user.userId,
      ]);
      const member = await acceptCampaignInvite({
        inviteToken,
        userId: req.user.userId,
        userEmail: userRows[0]?.email,
      });
      res.json(member);
    })
  );

  return router;
}

module.exports = createMembersRouter;
module.exports.createMembersRouter = createMembersRouter;
