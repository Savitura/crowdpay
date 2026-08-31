const db = require('../config/database');
const logger = require('../config/logger');

/**
 * Recalculates and adjusts referral commission when a contribution is partially or fully refunded.
 */
async function adjustReferralCommissionOnRefund({ contributionId, refundAmount }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: contribRows } = await client.query(
      'SELECT id, campaign_id, amount, referral_link_id FROM contributions WHERE id = $1 FOR UPDATE',
      [contributionId]
    );
    if (!contribRows.length) {
      await client.query('ROLLBACK');
      return;
    }

    const contrib = contribRows.length ? contribRows[0] : null;
    if (!contrib || !contrib.referral_link_id) {
      await client.query('ROLLBACK');
      return;
    }

    const { rows: linkRows } = await client.query(
      'SELECT id, user_id, campaign_id FROM referral_links WHERE id = $1',
      [contrib.referral_link_id]
    );
    if (!linkRows.length) {
      await client.query('ROLLBACK');
      return;
    }
    const link = linkRows[0];

    const { rows: progRows } = await client.query(
      'SELECT commission_percentage FROM referral_programs WHERE campaign_id = $1',
      [contrib.campaign_id]
    );
    if (!progRows.length) {
      await client.query('ROLLBACK');
      return;
    }
    const commissionPercentage = parseFloat(progRows[0].commission_percentage);

    const originalAmount = parseFloat(contrib.amount);
    const refundNum = parseFloat(refundAmount);
    const originalCommission = originalAmount * (commissionPercentage / 100);
    const newContributionAmount = Math.max(0, originalAmount - refundNum);
    const adjustedCommission = newContributionAmount * (commissionPercentage / 100);
    const commissionDifference = originalCommission - adjustedCommission;

    if (commissionDifference > 0) {
      const { rows: existingComm } = await client.query(
        'SELECT id, commission_amount, status FROM referral_commissions WHERE referral_link_id = $1 AND contribution_id = $2',
        [link.id, contributionId]
      );

      if (existingComm.length) {
        const commRow = existingComm[0];
        const updatedAmount = Math.max(0, parseFloat(commRow.commission_amount) - commissionDifference);
        await client.query(
          'UPDATE referral_commissions SET commission_amount = $1, updated_at = NOW() WHERE id = $2',
          [updatedAmount.toFixed(7), commRow.id]
        );

        await client.query(
          `INSERT INTO referral_commission_adjustments (referral_link_id, contribution_id, adjustment_amount, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [link.id, contributionId, (-commissionDifference).toFixed(7), 'partial_refund_adjustment']
        );
      }
    }

    await client.query('COMMIT');
    logger.info('Referral commission adjusted for refund', {
      contributionId,
      refundAmount,
      commissionDifference,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to adjust referral commission on refund', { error: err.message, contributionId });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  adjustReferralCommissionOnRefund,
  getReferralCodeFromRequest: (req) => req.query?.ref || req.body?.ref || null,
};