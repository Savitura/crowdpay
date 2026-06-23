const db = require('../config/database');
const { getCampaignBalance } = require('./stellarService');
const logger = require('../config/logger');

const MAX_STORED_RUNS = 20;
const recentRuns = [];

function recordReconciliationRun(summary) {
  recentRuns.unshift(summary);
  if (recentRuns.length > MAX_STORED_RUNS) recentRuns.length = MAX_STORED_RUNS;
}

function getRecentReconciliationRuns() {
  return [...recentRuns];
}

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
  const startedAt = new Date().toISOString();
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount FROM campaigns WHERE status IN ('active', 'funded')`
  );

  const summary = {
    started_at: startedAt,
    finished_at: null,
    campaigns_checked: rows.length,
    updated: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };

  for (const campaign of rows) {
    try {
      const result = await reconcileCampaign(campaign);
      if (result.skipped) {
        summary.skipped += 1;
      } else if (result.updated) {
        summary.updated += 1;
        summary.results.push({ campaign_id: campaign.id, updated: true, dbBalance: result.dbBalance, liveBalance: result.liveBalance });
      }
    } catch (err) {
      summary.errors += 1;
      summary.results.push({ campaign_id: campaign.id, error: err.message });
    }
  }

  summary.finished_at = new Date().toISOString();
  recordReconciliationRun(summary);
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

module.exports = {
  reconcileCampaignBalances,
  reconcileSingleCampaign,
  getRecentReconciliationRuns,
  recordReconciliationRun,
};
