const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  followCampaign,
  unfollowCampaign,
  updateFollowPreferences,
  getFollowState,
  countFollowers,
} = require('../services/campaignFollowService');

const PREFERENCE_KEYS = ['notify_updates', 'notify_milestones', 'notify_funding'];

async function loadCampaign(req, res, next) {
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL', [
    req.params.id,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  next();
}

// Follow state for the current user, plus the public follower count.
router.get(
  '/:id/follow',
  requireAuth,
  asyncHandler(loadCampaign),
  asyncHandler(async (req, res) => {
    const [state, followerCount] = await Promise.all([
      getFollowState(req.user.userId, req.params.id),
      countFollowers(req.params.id),
    ]);
    res.json({ ...state, follower_count: followerCount });
  })
);

router.post(
  '/:id/follow',
  requireAuth,
  asyncHandler(loadCampaign),
  asyncHandler(async (req, res) => {
    const follow = await followCampaign(req.user.userId, req.params.id, req.body || {});
    res.status(201).json({ ...follow, follower_count: await countFollowers(req.params.id) });
  })
);

// Change which events a followed campaign notifies about.
router.patch(
  '/:id/follow',
  requireAuth,
  asyncHandler(loadCampaign),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const provided = PREFERENCE_KEYS.filter(key => typeof body[key] === 'boolean');
    if (!provided.length) {
      return res.status(422).json({
        error: `Provide at least one boolean preference: ${PREFERENCE_KEYS.join(', ')}`,
      });
    }

    const follow = await updateFollowPreferences(req.user.userId, req.params.id, body);
    if (!follow) {
      return res.status(404).json({ error: 'You are not following this campaign' });
    }
    res.json(follow);
  })
);

router.delete(
  '/:id/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    await unfollowCampaign(req.user.userId, req.params.id);
    res.status(204).send();
  })
);

module.exports = router;
