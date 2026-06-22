const db = require('../config/database');
const { getCampaignBalance } = require('./stellarService');
const logger = require('../config/logger');

async function reconcileCampaign(campaign) {
  try {
    const { rows: pendingRows } = await db.query(
      `SELECT id FROM withdrawal_requests WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
      [campaign.id]
    );
    if (pendingRows.length > 0) {
      logger.info(`[reconcile] Skipping campaign ${campaign.id} due to pending withdrawal`);
      return { skipped: true, reason: 'pending_withdrawal' };
    }

    const onChain = await getCampaignBalance(campaign.wallet_public_key);
    const liveBalance = parseFloat(onChain[campaign.asset_type] || '0');
    const dbBalance = parseFloat(campaign.raised_amount);

    if (Math.abs(liveBalance - dbBalance) > 0.0000001) {
      logger.warn(`[reconcile] Campaign ${campaign.id}: DB=${dbBalance} vs chain=${liveBalance}. Updating.`);
      await db.query(
        `UPDATE campaigns SET raised_amount = $1 WHERE id = $2`,
        [liveBalance, campaign.id]
      );
      return { updated: true, dbBalance, liveBalance };
    }
    return { updated: false, dbBalance, liveBalance };
  } catch (err) {
    logger.error(`[reconcile] Failed for campaign ${campaign.id}:`, { error: err.message });
    throw err;
  }
}

async function reconcileCampaignBalances() {
  const startedAt = new Date();
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount FROM campaigns WHERE status IN ('active', 'funded')`
  );

  let mismatchesFound = 0;
  const mismatches = [];
  for (const campaign of rows) {
    try {
      const result = await reconcileCampaign(campaign);
      if (result && result.updated) {
        mismatchesFound += 1;
        mismatches.push({ campaign_id: campaign.id, dbBalance: result.dbBalance, liveBalance: result.liveBalance });
      }
    } catch (err) {
      // Error is already logged inside reconcileCampaign
    }
  }

  try {
    await db.query(
      `INSERT INTO reconciliation_runs (started_at, finished_at, campaigns_checked, mismatches_found, details)
       VALUES ($1, NOW(), $2, $3, $4::jsonb)`,
      [startedAt, rows.length, mismatchesFound, JSON.stringify({ mismatches })]
    );
  } catch (err) {
    logger.error('[reconcile] Failed to record reconciliation run', { error: err.message });
  }
}

async function reconcileSingleCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!rows.length) {
    throw new Error('Campaign not found');
  }
  return await reconcileCampaign(rows[0]);
}

async function getRecentReconciliationRuns(limit = 10) {
  const { rows } = await db.query(
    `SELECT id, started_at, finished_at, campaigns_checked, mismatches_found, details
     FROM reconciliation_runs
     ORDER BY finished_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  reconcileCampaignBalances,
  reconcileSingleCampaign,
  getRecentReconciliationRuns,
};
