const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const campaignId = req.query.campaignId || null;
  const status = req.query.status || null;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);

  const conditions = [];
  const params = [];
  let idx = 1;

  if (campaignId) {
    conditions.push(`campaign_id = $${idx++}`);
    params.push(campaignId);
  }
  if (status) {
    conditions.push(`status = $${idx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(
    `SELECT COUNT(*) FROM creator_refunds ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await db.query(
    `SELECT id, campaign_id, contribution_id, recipient_wallet, amount, asset, reason, status, processed_at, stellar_tx_hash, created_at, created_by
     FROM creator_refunds
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  );

  res.json({ total, limit, offset, items: dataResult.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { campaignId, contributionId, recipientWallet, amount, asset, reason } = req.body;

  if (!campaignId || !recipientWallet || !amount || amount <= 0) {
    return res.status(400).json({ error: 'campaignId, recipientWallet, and positive amount are required' });
  }

  const { rows } = await db.query(
    `INSERT INTO creator_refunds (campaign_id, contribution_id, recipient_wallet, amount, asset, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [campaignId, contributionId || null, recipientWallet, amount, asset || 'native', reason || null, req.user.userId],
  );

  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, stellarTxHash } = req.body;

  const allowedStatus = ['pending', 'processing', 'completed', 'failed'];
  if (status && !allowedStatus.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${allowedStatus.join(', ')}` });
  }

  const fields = [];
  const params = [];
  let idx = 1;

  if (status) {
    fields.push(`status = $${idx++}`);
    params.push(status);
    if (status === 'completed' || status === 'failed') {
      fields.push(`processed_at = NOW()`);
    }
  }
  if (stellarTxHash) {
    fields.push(`stellar_tx_hash = $${idx++}`);
    params.push(stellarTxHash);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(id);
  const { rows } = await db.query(
    `UPDATE creator_refunds SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Refund not found' });
  }

  res.json(rows[0]);
}));

module.exports = router;
