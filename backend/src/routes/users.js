const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/me/campaigns', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.status, c.asset_type, c.target_amount, c.raised_amount,
            c.deadline, c.created_at,
            COALESCE(stats.contributor_count, 0) AS contributor_count
     FROM campaigns c
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT sender_public_key)::int AS contributor_count
       FROM contributions ctr
       WHERE ctr.campaign_id = c.id
     ) stats ON TRUE
     WHERE c.creator_id = $1
     ORDER BY c.created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

router.get('/me/stats', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT
      COUNT(*)::int AS total_campaigns,
      COALESCE(SUM(raised_amount), 0)::numeric AS total_raised,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
      COUNT(*) FILTER (WHERE status = 'funded')::int AS funded_campaigns,
      COUNT(*) FILTER (WHERE status IN ('closed', 'withdrawn', 'failed'))::int AS closed_campaigns
     FROM campaigns
     WHERE creator_id = $1`,
    [req.user.userId]
  );
  res.json(rows[0]);
});

router.get('/me/contributions', requireAuth, async (req, res) => {
  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });

  const senderPublicKey = userRows[0].wallet_public_key;
  const { rows } = await db.query(
    `SELECT ctr.id, ctr.amount, ctr.asset, ctr.tx_hash, ctr.created_at,
            c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
            c.target_amount, c.raised_amount
     FROM contributions ctr
     JOIN campaigns c ON c.id = ctr.campaign_id
     WHERE ctr.sender_public_key = $1
     ORDER BY ctr.created_at DESC`,
    [senderPublicKey]
  );
  res.json(rows);
});

module.exports = router;