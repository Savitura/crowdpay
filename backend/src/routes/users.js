const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createKycSession, isKycRequiredForCampaigns } = require('../services/kycProvider');

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at, created_at
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ...rows[0], kyc_required_for_campaigns: isKycRequiredForCampaigns() });
});

router.post('/me/kyc/start', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, role, kyc_status
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  const user = rows[0];
  if (user.kyc_status === 'verified') {
    return res.json({
      status: 'verified',
      message: 'Identity verification is already complete.',
    });
  }

  try {
    const session = await createKycSession({ user });
    const { rows: updatedRows } = await db.query(
      `UPDATE users
       SET kyc_status = 'pending',
           kyc_provider_reference = COALESCE($2, kyc_provider_reference),
           kyc_completed_at = NULL
       WHERE id = $1
       RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at`,
      [user.id, session.providerReference || null]
    );

    res.status(201).json({
      status: updatedRows[0].kyc_status,
      provider: session.provider,
      provider_reference: session.providerReference,
      redirect_url: session.redirectUrl,
      session_token: session.sessionToken,
      user: {
        ...updatedRows[0],
        kyc_required_for_campaigns: isKycRequiredForCampaigns(),
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Could not start identity verification' });
  }
});

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
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_campaigns,
      COUNT(*) FILTER (WHERE status IN ('completed', 'closed', 'withdrawn', 'failed'))::int AS closed_campaigns
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
    `SELECT ctr.id, ctr.amount, ctr.asset, ctr.anchor_id, ctr.anchor_transaction_id,
            ctr.tx_hash, ctr.created_at,
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
