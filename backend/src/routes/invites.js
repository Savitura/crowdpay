const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  getInvitePreview,
  acceptCampaignInvite,
} = require('../services/campaignInviteService');

/**
 * @openapi
 * tags:
 *   - name: Invites
 *     description: Campaign team invitations
 */

router.get('/:token', asyncHandler(async (req, res) => {
  const preview = await getInvitePreview(req.params.token);
  if (!preview) return res.status(404).json({ error: 'Invitation not found' });
  if (preview.accepted_at) {
    return res.status(409).json({ error: 'Invitation already accepted', ...preview });
  }
  if (preview.expired) {
    return res.status(410).json({ error: 'Invitation has expired', ...preview });
  }
  res.json(preview);
}));

router.post('/:token/accept', requireAuth, asyncHandler(async (req, res) => {
  const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
  const member = await acceptCampaignInvite({
    inviteToken: req.params.token,
    userId: req.user.userId,
    userEmail: userRows[0]?.email,
  });
  res.json(member);
}));

module.exports = router;
