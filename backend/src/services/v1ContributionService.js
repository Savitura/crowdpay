const { server } = require('../config/stellar');
const db = require('../config/database');
const logger = require('../config/logger');
const { refreshCampaignStatus } = require('./campaignStatusService');

function assetLabel(record) {
  if (!record) return 'XLM';
  if (record.asset_type === 'native') return 'XLM';
  return record.asset_code || 'XLM';
}

async function loadOperations(txHash) {
  const result = await server.operations().forTransaction(txHash).call();
  return result.records || [];
}

function parseContributionFromOperations(operations, campaign) {
  for (const op of operations) {
    if (op.type === 'payment' && op.to === campaign.wallet_public_key) {
      return {
        sender_public_key: op.from,
        amount: Number(op.amount),
        asset: assetLabel(op),
        payment_type: 'payment',
        source_amount: null,
        source_asset: null,
        conversion_rate: null,
        path: null,
      };
    }

    if (op.type === 'path_payment_strict_receive' && op.to === campaign.wallet_public_key) {
      const destAmount = Number(op.amount);
      const sourceAmount = Number(op.source_amount);
      return {
        sender_public_key: op.from,
        amount: destAmount,
        asset: assetLabel(op),
        payment_type: 'path_payment_strict_receive',
        source_amount: sourceAmount,
        source_asset: assetLabel({
          asset_type: op.source_asset_type,
          asset_code: op.source_asset_code,
        }),
        conversion_rate:
          sourceAmount && destAmount ? destAmount / sourceAmount : null,
        path: null,
      };
    }
  }

  const err = new Error('Transaction does not contain a payment to the campaign wallet');
  err.statusCode = 422;
  throw err;
}

async function recordContributionFromTxHash({ campaignId, txHash }) {
  const { rows: campaigns } = await db.query(
    'SELECT id, wallet_public_key, asset_type, status, raised_amount, target_amount FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaigns.length) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }

  const campaign = campaigns[0];
  if (!['active', 'funded'].includes(campaign.status)) {
    const err = new Error(`Campaign status "${campaign.status}" does not accept contributions`);
    err.statusCode = 409;
    throw err;
  }

  const existing = await db.query('SELECT id FROM contributions WHERE tx_hash = $1', [txHash]);
  if (existing.rows.length) {
    const err = new Error('Contribution already recorded for this transaction');
    err.statusCode = 409;
    throw err;
  }

  let tx;
  try {
    tx = await server.transactions().transaction(txHash).call();
  } catch (err) {
    logger.warn('Horizon transaction lookup failed', { tx_hash: txHash, error: err.message });
    const notFound = new Error('Stellar transaction not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  if (!tx.successful) {
    const err = new Error('Stellar transaction was not successful');
    err.statusCode = 422;
    throw err;
  }

  const operations = await loadOperations(txHash);
  const parsed = parseContributionFromOperations(operations, campaign);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: inserted } = await client.query(
      `INSERT INTO contributions
         (campaign_id, sender_public_key, amount, asset, payment_type,
          source_amount, source_asset, conversion_rate, path, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        campaignId,
        parsed.sender_public_key,
        parsed.amount,
        parsed.asset,
        parsed.payment_type,
        parsed.source_amount,
        parsed.source_asset,
        parsed.conversion_rate,
        parsed.path ? JSON.stringify(parsed.path) : null,
        txHash,
      ]
    );

    await client.query(
      `UPDATE campaigns
       SET raised_amount = raised_amount + $1,
           status = CASE
             WHEN raised_amount + $1 >= target_amount THEN 'funded'
             ELSE status
           END
       WHERE id = $2`,
      [parsed.amount, campaignId]
    );

    await client.query('COMMIT');
    await refreshCampaignStatus(campaignId);
    return inserted[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  recordContributionFromTxHash,
  parseContributionFromOperations,
};
