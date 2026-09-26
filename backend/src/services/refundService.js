async function getCampaignRefunds(campaignId, { status = null, limit = 50, offset = 0 } = {}) {
  const conditions = ['campaign_id = $1'];
  const params = [campaignId];
  let idx = 2;

  if (status) {
    conditions.push(`status = $${idx}`);
    params.push(status);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const countResult = await db.query(`SELECT COUNT(*) FROM creator_refunds ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const limitIdx = idx++;
  const offsetIdx = idx++;
  params.push(parsedLimit, parsedOffset);

  const dataResult = await db.query(
    `SELECT id, campaign_id, contribution_id, recipient_wallet, amount, asset, reason,
            status, processed_at, tx_hash, is_force_refund, admin_note, failure_reason, created_at, created_by
     FROM creator_refunds
     ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return { total, limit: parsedLimit, offset: parsedOffset, items: dataResult.rows };
}

const db = require('../config/database');
const logger = require('../config/logger');
const stellarService = require('./stellarService');

async function getEligibleContributions(campaignId, options = {}) {
  const limit = Math.max(1, Math.min(500, parseInt(options.limit, 10) || 50));
  const offset = Math.max(0, parseInt(options.offset, 10) || 0);

  const { rows } = await db.query(
    `SELECT id, campaign_id, sender_public_key, amount, refunded_amount, status, created_at
     FROM contributions
     WHERE campaign_id = $1 AND status != 'refunded'
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset]
  );
  return rows;
}

async function listRefunds(campaignId, options = {}) {
  const limit = Math.max(1, Math.min(500, parseInt(options.limit, 10) || 50));
  const offset = Math.max(0, parseInt(options.offset, 10) || 0);

  const { rows } = await db.query(
    `SELECT id, campaign_id, contribution_id, amount, status, tx_hash, created_at
     FROM refunds
     WHERE campaign_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset]
  );
  return rows;
}

async function processRefund(contributionId, amount, service = stellarService) {
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    throw new Error('Invalid refund amount');
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: contribRows } = await client.query(
      `SELECT id, campaign_id, sender_public_key, amount, refunded_amount
       FROM contributions
       WHERE id = $1 FOR UPDATE`,
      [contributionId]
    );

    if (!contribRows.length) {
      throw new Error('Contribution not found');
    }

    const contrib = contribRows[0];
    const remaining = Number(contrib.amount) - Number(contrib.refunded_amount || 0);

    if (numericAmount > remaining) {
      throw new Error('Refund amount exceeds remaining contribution balance');
    }

    let txHash = null;
    if (service && typeof service.sendCampaignRefund === 'function') {
      const result = await service.sendCampaignRefund({
        campaignId: contrib.campaign_id,
        destinationKey: contrib.sender_public_key,
        amount: numericAmount,
      });
      if (result && result.txHash) {
        txHash = result.txHash;
      }
    }

    if (!txHash) {
      await client.query('ROLLBACK');
      throw new Error('On-chain refund transaction failed or missing transaction hash');
    }

    const { rows: refundRows } = await client.query(
      `INSERT INTO refunds (campaign_id, contribution_id, amount, status, tx_hash, created_at)
       VALUES ($1, $2, $3, 'completed', $4, NOW())
       RETURNING id, campaign_id, contribution_id, amount, status, tx_hash, created_at`,
      [contrib.campaign_id, contributionId, numericAmount, txHash]
    );

    await client.query(
      `UPDATE contributions
       SET refunded_amount = COALESCE(refunded_amount, 0) + $1,
           status = CASE WHEN (COALESCE(refunded_amount, 0) + $1) >= amount THEN 'refunded' ELSE status END
       WHERE id = $2`,
      [numericAmount, contributionId]
    );

    await client.query(
      `UPDATE campaigns
       SET raised_amount = GREATEST(0, raised_amount - $1)
       WHERE id = $2`,
      [numericAmount, contrib.campaign_id]
    );

    await client.query('COMMIT');
    return refundRows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getEligibleContributions,
  listRefunds,
  processRefund,
};
