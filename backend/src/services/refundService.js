const db = require('../config/database');
const logger = require('../config/logger');
const { createNotification } = require('./notifications');
const { sendEmail } = require('./emailService');
const { logAuditEvent } = require('./auditService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('./webhookDispatcher');

async function getEligibleContributions(campaignId) {
  const { rows } = await db.query(
    `SELECT
       c.id,
       c.amount,
       c.asset,
       c.refunded_amount,
       c.refund_status,
       (c.amount - c.refunded_amount) AS remaining_amount,
       c.sender_public_key,
       c.created_at,
       u.id AS contributor_id,
       u.display_name AS contributor_name,
       u.email AS contributor_email,
       u.wallet_public_key AS contributor_wallet
     FROM contributions c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.campaign_id = $1
       AND c.status = 'completed'
       AND (c.amount - c.refunded_amount) > 0
     ORDER BY c.created_at DESC`,
    [campaignId]
  );
  return rows;
}

async function getCampaignRefunds(campaignId, { status = null, limit = 50, offset = 0 } = {}) {
  const conditions = ['campaign_id = $1'];
  const params = [campaignId];
  let idx = 2;

  if (status) {
    conditions.push(`status = $${idx++}`);
    params.push(status);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const countResult = await db.query(`SELECT COUNT(*) FROM creator_refunds ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await db.query(
    `SELECT id, campaign_id, contribution_id, recipient_wallet, amount, asset, reason,
            status, processed_at, tx_hash, is_force_refund, admin_note, failure_reason, created_at, created_by
     FROM creator_refunds
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, Math.min(parseInt(limit, 10), 500), parseInt(offset, 10)]
  );

  return { total, limit, offset, items: dataResult.rows };
}

async function processRefund({
  campaignId,
  contributionId,
  amount,
  reason,
  initiatorId,
  isForceRefund = false,
  adminNote = null,
}) {
  const client = await db.connect();
  let refundRow = null;

  try {
    await client.query('BEGIN');

    const { rows: contribRows } = await client.query(
      `SELECT c.id, c.amount, c.refunded_amount, c.asset, c.sender_public_key,
              c.campaign_id, c.user_id,
              u.email AS contributor_email,
              u.display_name AS contributor_name,
              u.wallet_public_key AS contributor_wallet
       FROM contributions c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = $1 AND c.campaign_id = $2 AND c.status = 'completed'
       FOR UPDATE`,
      [contributionId, campaignId]
    );

    if (contribRows.length === 0) {
      throw Object.assign(new Error('Contribution not found or not eligible for refund'), { status: 404 });
    }

    const contrib = contribRows[0];
    const remaining = parseFloat(contrib.amount) - parseFloat(contrib.refunded_amount || 0);

    if (amount <= 0 || amount > remaining) {
      throw Object.assign(
        new Error(`Refund amount must be > 0 and <= remaining refundable amount (${remaining})`),
        { status: 422 }
      );
    }

    const refundInsert = await client.query(
      `INSERT INTO creator_refunds
         (campaign_id, contribution_id, recipient_wallet, amount, asset, reason, status, is_force_refund, admin_note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, $8, $9)
       RETURNING *`,
      [
        campaignId,
        contributionId,
        contrib.contributor_wallet || contrib.sender_public_key,
        amount,
        contrib.asset || 'native',
        reason || null,
        isForceRefund,
        adminNote || null,
        initiatorId,
      ]
    );
    refundRow = refundInsert.rows[0];

    let txHash = null;
    try {
      const stellarService = require('./stellarService');
      if (typeof stellarService.sendCampaignRefund === 'function') {
        const result = await stellarService.sendCampaignRefund({
          campaignId,
          recipientWallet: refundRow.recipient_wallet,
          amount,
          asset: refundRow.asset,
        });
        txHash = result?.hash || result?.id || null;
      }
    } catch (onChainErr) {
      logger.error('on_chain_refund_failed', { refundId: refundRow.id, error: onChainErr.message });

      await client.query(
        `UPDATE creator_refunds SET status = 'failed', failure_reason = $1, processed_at = NOW() WHERE id = $2`,
        [onChainErr.message, refundRow.id]
      );

      await client.query('COMMIT');
      throw Object.assign(new Error('On-chain refund failed - state rolled back'), { status: 502, cause: onChainErr });
    }

    const newRefunded = parseFloat(contrib.refunded_amount || 0) + amount;
    const newRefundStatus = newRefunded >= parseFloat(contrib.amount) ? 'full' : 'partial';

    await client.query(
      `UPDATE contributions SET refunded_amount = $1, refund_status = $2 WHERE id = $3`,
      [newRefunded, newRefundStatus, contributionId]
    );

    await client.query(
      `UPDATE campaigns SET raised_amount = GREATEST(0, raised_amount - $1) WHERE id = $2`,
      [amount, campaignId]
    );

    await client.query(
      `UPDATE creator_refunds SET status = 'completed', tx_hash = $1, processed_at = NOW() WHERE id = $2`,
      [txHash, refundRow.id]
    );

    await client.query('COMMIT');

    setImmediate(async () => {
      try {
        await logAuditEvent({
          actorId: initiatorId,
          action: isForceRefund ? 'admin_force_refund' : 'creator_refund',
          resourceType: 'refund',
          resourceId: refundRow.id,
          metadata: { campaignId, contributionId, amount, txHash },
        });

        if (contrib.user_id) {
          await createNotification(contrib.user_id, {
            type: 'refund_issued',
            title: 'Refund Issued',
            body: `A refund of ${amount} ${refundRow.asset} has been returned to your wallet.`,
            link: `/campaigns/${campaignId}`,
          });

          if (contrib.contributor_email) {
            await sendEmail({
              to: contrib.contributor_email,
              subject: 'Your refund has been processed',
              html: `<p>Hi ${contrib.contributor_name || 'there'},</p><p>A refund of <strong>${amount} ${refundRow.asset}</strong> has been returned to your wallet${txHash ? ` (tx: ${txHash})` : ''}.</p>`,
            });
          }

          if (WEBHOOK_EVENTS && WEBHOOK_EVENTS.REFUND_ISSUED) {
            await emitWebhookEventForUser(contrib.user_id, WEBHOOK_EVENTS.REFUND_ISSUED, {
              refundId: refundRow.id,
              campaignId,
              contributionId,
              amount,
              txHash,
            }).catch(() => {});
          }
        }
      } catch (sideEffectErr) {
        logger.warn('refund_side_effect_failed', { error: sideEffectErr.message });
      }
    });

    return { ...refundRow, status: 'completed', tx_hash: txHash };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getEligibleContributions, getCampaignRefunds, processRefund };
