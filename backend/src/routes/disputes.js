const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendEmail } = require('../services/emailService');
const logger = require('../config/logger');

async function logDisputeEvent(client, { disputeId, actorId, action, note }) {
  await client.query(
    `INSERT INTO dispute_events (dispute_id, actor_id, action, note)
     VALUES ($1, $2, $3, $4)`,
    [disputeId, actorId || null, action, note || null]
  );
}

// POST /campaigns/:id/disputes — contributor raises a dispute
router.post('/campaigns/:id/disputes', requireAuth, async (req, res) => {
  const { reason, description, evidence_url } = req.body;

  const VALID_REASONS = ['non_delivery', 'misrepresentation', 'abandoned', 'other'];
  if (!VALID_REASONS.includes(reason)) {
    return res.status(422).json({ error: `reason must be one of: ${VALID_REASONS.join(', ')}` });
  }
  if (!description || !description.trim()) {
    return res.status(422).json({ error: 'description is required' });
  }

  const { rows: campaigns } = await db.query(
    'SELECT id, creator_id, title FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];

  // Must have contributed
  const { rows: contributions } = await db.query(
    `SELECT id FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = (
       SELECT wallet_public_key FROM users WHERE id = $2
     ) LIMIT 1`,
    [campaign.id, req.user.userId]
  );
  if (!contributions.length) {
    return res.status(403).json({ error: 'Only contributors who have backed this campaign can raise a dispute' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO disputes (campaign_id, raised_by, reason, description, evidence_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [campaign.id, req.user.userId, reason, description.trim(), evidence_url || null]
    );
    const dispute = rows[0];

    await logDisputeEvent(client, {
      disputeId: dispute.id,
      actorId: req.user.userId,
      action: 'raised',
      note: reason,
    });

    // Freeze any pending withdrawal requests for this campaign
    await client.query(
      `UPDATE withdrawal_requests
       SET status = 'on_hold', dispute_id = $1
       WHERE campaign_id = $2 AND status = 'pending'`,
      [dispute.id, campaign.id]
    );

    await client.query('COMMIT');

    // Notify creator
    const { rows: creatorRows } = await db.query(
      'SELECT email FROM users WHERE id = $1',
      [campaign.creator_id]
    );
    if (creatorRows.length) {
      sendEmail({
        to: creatorRows[0].email,
        subject: `Dispute raised on your campaign "${campaign.title}"`,
        text: `A contributor has raised a dispute on your campaign "${campaign.title}".\nReason: ${reason}\n\nThe platform team will review and contact you shortly.`,
      });
    }

    logger.info('Dispute raised', { dispute_id: dispute.id, campaign_id: campaign.id });
    res.status(201).json(dispute);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have an open dispute for this campaign' });
    }
    logger.error('Dispute creation failed', { error: err.message });
    res.status(500).json({ error: 'Could not raise dispute' });
  } finally {
    client.release();
  }
});

// GET /campaigns/:id/disputes — admin only
router.get('/campaigns/:id/disputes', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT d.*, u.name AS raised_by_name, u.email AS raised_by_email
     FROM disputes d
     JOIN users u ON u.id = d.raised_by
     WHERE d.campaign_id = $1
     ORDER BY d.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

// PATCH /disputes/:id — admin updates status + resolution note
router.patch('/disputes/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { status, resolution_note } = req.body;

  const VALID_STATUSES = ['open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed'];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(422).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const { rows: disputes } = await db.query(
    'SELECT * FROM disputes WHERE id = $1',
    [req.params.id]
  );
  if (!disputes.length) return res.status(404).json({ error: 'Dispute not found' });
  const dispute = disputes[0];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const resolvedAt = ['resolved_creator', 'resolved_contributor', 'closed'].includes(status)
      ? 'NOW()'
      : 'NULL';

    const { rows: updated } = await client.query(
      `UPDATE disputes
       SET status = $1, resolution_note = $2, resolved_at = ${resolvedAt}
       WHERE id = $3
       RETURNING *`,
      [status, resolution_note || null, dispute.id]
    );

    await logDisputeEvent(client, {
      disputeId: dispute.id,
      actorId: req.user.userId,
      action: `status_changed_to_${status}`,
      note: resolution_note || null,
    });

    if (status === 'resolved_contributor') {
      // Trigger refund for the disputing contributor
      const { rows: campaigns } = await client.query(
        'SELECT wallet_public_key FROM campaigns WHERE id = $1',
        [dispute.campaign_id]
      );
      const { rows: contributorRows } = await client.query(
        'SELECT wallet_public_key FROM users WHERE id = $1',
        [dispute.raised_by]
      );
      const { rows: contributions } = await client.query(
        `SELECT id, amount, asset FROM contributions
         WHERE campaign_id = $1 AND sender_public_key = $2
         AND NOT EXISTS (
           SELECT 1 FROM withdrawal_requests wr WHERE wr.contribution_id = contributions.id
         )`,
        [dispute.campaign_id, contributorRows[0].wallet_public_key]
      );

      const { buildWithdrawalTransaction } = require('../services/stellarService');
      const { insertWithdrawalPendingSignatures } = require('../services/stellarTransactionService');

      for (const contribution of contributions) {
        const unsignedXdr = await buildWithdrawalTransaction({
          campaignWalletPublicKey: campaigns[0].wallet_public_key,
          destinationPublicKey: contributorRows[0].wallet_public_key,
          amount: contribution.amount,
          asset: contribution.asset,
        });
        const { rows: refundRows } = await client.query(
          `INSERT INTO withdrawal_requests
             (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
              creator_signed, platform_signed, contribution_id, is_refund, dispute_id)
           VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6, TRUE, $7)
           RETURNING id`,
          [
            dispute.campaign_id, req.user.userId, contribution.amount,
            contributorRows[0].wallet_public_key, unsignedXdr,
            contribution.id, dispute.id,
          ]
        );
        await insertWithdrawalPendingSignatures(client, {
          campaignId: dispute.campaign_id,
          withdrawalRequestId: refundRows[0].id,
          userId: req.user.userId,
          unsignedXdr,
          metadata: { dispute_id: dispute.id, contribution_id: contribution.id },
        });
      }

      // Notify contributor
      const { rows: userRows } = await db.query(
        'SELECT email FROM users WHERE id = $1',
        [dispute.raised_by]
      );
      if (userRows.length) {
        sendEmail({
          to: userRows[0].email,
          subject: 'Your dispute has been resolved in your favour',
          text: `Your dispute has been resolved. A refund has been initiated for your contributions. ${resolution_note ? `\nNote: ${resolution_note}` : ''}`,
        });
      }
    }

    if (status === 'resolved_creator') {
      // Unfreeze pending on_hold withdrawals for this campaign
      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'pending', dispute_id = NULL
         WHERE campaign_id = $1 AND status = 'on_hold' AND dispute_id = $2`,
        [dispute.campaign_id, dispute.id]
      );
    }

    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Dispute update failed', { dispute_id: dispute.id, error: err.message });
    res.status(500).json({ error: 'Could not update dispute' });
  } finally {
    client.release();
  }
});

// GET /disputes/:id/events — audit log (admin only)
router.get('/disputes/:id/events', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT de.*, u.name AS actor_name
     FROM dispute_events de
     LEFT JOIN users u ON u.id = de.actor_id
     WHERE de.dispute_id = $1
     ORDER BY de.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

module.exports = router;
