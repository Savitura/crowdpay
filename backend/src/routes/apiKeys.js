const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const {
  listApiKeysForUser,
  createApiKeyForUser,
  revokeApiKeyForUser,
} = require('../services/apiKeyService');
const asyncHandler = require('../utils/asyncHandler');

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const keys = await listApiKeysForUser(req.user.userId);
  res.json(keys);
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const created = await createApiKeyForUser(req.user.userId, req.body || {});
  res.status(201).json(created);
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const revoked = await revokeApiKeyForUser(req.user.userId, req.params.id);
  if (!revoked) return res.status(404).json({ error: 'API key not found' });
  res.json({ revoked: true, id: revoked.id });
}));

module.exports = router;
