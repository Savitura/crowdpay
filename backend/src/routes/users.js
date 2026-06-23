const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const { startKycForUser } = require('../services/kycService');
const { listCreatorCampaigns, listUserContributions } = require('../services/userDashboardService');
const asyncHandler = require('../utils/asyncHandler');

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, wallet_public_key, wallet_type, role, kyc_status, kyc_completed_at, created_at
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ...rows[0], kyc_required_for_campaigns: isKycRequiredForCampaigns() });
}));

router.post('/me/kyc/start', requireAuth, asyncHandler(async (req, res) => {
  try {
    const result = await startKycForUser(req.user.userId);
    if (result.status === 'verified') {
      return res.json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(502).json({ error: err.message || 'Could not start identity verification' });
  }
}));

router.get('/me/campaigns', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listCreatorCampaigns(req.user.userId);
  res.json(campaigns);
}));

router.get('/me/stats', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT
      COUNT(*)::int AS total_campaigns,
      COALESCE(SUM(raised_amount), 0)::numeric AS total_raised,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
      COUNT(*) FILTER (WHERE status = 'funded')::int AS funded_campaigns,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_campaigns,
      COUNT(*) FILTER (WHERE status IN ('completed', 'closed', 'withdrawn', 'failed'))::int AS closed_campaigns
     FROM campaigns
     WHERE creator_id = $1`,
    [req.user.userId]
  );
  res.json(rows[0]);
}));

const { getCampaignBalance } = require('../services/stellarService');

router.get('/me/balance', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json({ balance, public_key: rows[0].wallet_public_key });
}));

router.get('/me/contributions', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return res.status(404).json({ error: 'User not found' });
  res.json(rows);
}));

const { getUserDashboardAnalytics } = require('../services/analyticsService');

router.get('/me/dashboard/analytics', requireAuth, asyncHandler(async (req, res) => {
  const data = await getUserDashboardAnalytics(req.user.userId);
  res.json(data);
}));

// GET /api/users/me — already proposed in issue #163, implement together
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, wallet_public_key, created_at FROM users WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// PATCH /api/users/me — update display name only
router.patch('/me', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { rows } = await db.query(
    `UPDATE users SET name = $1 WHERE id = $2
     RETURNING id, email, name, wallet_public_key, created_at`,
    [name.trim(), req.user.userId]
  );
  res.json(rows[0]);
});

module.exports = router;
