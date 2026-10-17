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
const withTransaction = require('../utils/withTransaction');

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
  let reason = null;
  let initiatorId = null;
  let isForceRefund = false;
  let adminNote = null;
  if (contributionId && typeof contributionId === 'object') {
    const options = contributionId;
    contributionId = options.contributionId;
    amount = options.amount;
    service = options.service || service;
    reason = options.reason || null;
    initiatorId = options.initiatorId || null;
    isForceRefund = Boolean(options.isForceRefund);
    adminNote = options.adminNote || null;
  }
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    const error = new Error('Invalid refund amount');
    error.status = 400;
    throw error;
  }

  const pool = typeof db.connect === 'function' ? db : db.pool;
  return withTransaction(async client => {
    const { rows: contribRows } = await client.query(
      `SELECT id, campaign_id, sender_public_key, amount, refunded_amount,
              c.wallet_public_key, c.creator_id
       FROM contributions JOIN campaigns c ON c.id = contributions.campaign_id
       WHERE contributions.id = $1 FOR UPDATE`,
      [contributionId]
    );

    if (!contribRows.length) {
      const error = new Error('Contribution not found');
      error.status = 404;
      throw error;
    }

    const contrib = contribRows[0];
    const remaining = Number(contrib.amount) - Number(contrib.refunded_amount || 0);

    if (numericAmount > remaining) {
      const error = new Error('Refund amount exceeds remaining contribution balance');
      error.status = 422;
      throw error;
    }

    let txHash = null;
    try {
      if (service && typeof service.sendCampaignRefund === 'function') {
        const result = await service.sendCampaignRefund({
          campaignId: contrib.campaign_id,
          destinationKey: contrib.sender_public_key,
          amount: numericAmount,
        });
        txHash = result?.txHash || result?.hash || null;
      } else if (service && typeof service.submitDisputeRefund === 'function') {
        const result = await service.submitDisputeRefund({
          campaignWalletPublicKey: contrib.wallet_public_key,
          creatorId: contrib.creator_id,
          refunds: [{ walletPublicKey: contrib.sender_public_key, amount: numericAmount }],
        });
        txHash = result?.txHash || result?.hash || null;
      }
    } catch (err) {
      logger.error('On-chain refund transfer failed', {
        contributionId,
        campaignId: contrib.campaign_id,
        error: err.message,
      });
      txHash = null;
    }

    if (!txHash) {
      const error = new Error('On-chain refund transaction failed or missing transaction hash');
      error.status = 502;
      throw error;
    }

    const { rows: refundRows } = await client.query(
      `INSERT INTO creator_refunds
         (campaign_id, contribution_id, recipient_wallet, amount, asset, reason, status,
          tx_hash, stellar_tx_hash, is_force_refund, admin_note, created_by, processed_at)
       VALUES ($1, $2, $3, $4, 'native', $5, 'completed', $6, $6, $7, $8, $9, NOW())
       RETURNING id, campaign_id, contribution_id, amount, status, tx_hash, is_force_refund, admin_note, created_at`,
      [
        contrib.campaign_id,
        contributionId,
        contrib.sender_public_key,
        numericAmount,
        reason,
        txHash,
        isForceRefund,
        adminNote,
        initiatorId,
      ]
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

    return refundRows[0];
  }, pool);
}

module.exports = {
  getEligibleContributions,
  listRefunds,
  processRefund,
};
