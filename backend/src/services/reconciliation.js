const Sentry = require('@sentry/node');
const db = require('../config/database');
const logger = require('../config/logger');
const cache = require('../utils/cache');
const { getCampaignBalance } = require('./stellarService');
const { insertReconciliationAdjustment } = require('./stellarTransactionService');

const DISCREPANCY_EPSILON = 0.0000001;

function getReconciliationAlertThreshold() {
  const raw = process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD;
  if (raw === undefined || raw === '') return 1;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

function hasDiscrepancy(dbBalance, liveBalance) {
  return Math.abs(liveBalance - dbBalance) > DISCREPANCY_EPSILON;
}

function alertDiscrepancyIfNeeded(campaignId, audit) {
  const threshold = getReconciliationAlertThreshold();
  if (Math.abs(audit.diff) < threshold) return;

  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setTag('campaign_id', campaignId);
    scope.setContext('reconciliation', audit);
    Sentry.captureMessage('Campaign raised_amount reconciliation discrepancy');
  });
}

async function applyReconciliationCorrection(campaign, dbBalance, liveBalance) {
  const diff = liveBalance - dbBalance;
  const audit = {
    campaign_id: campaign.id,
    db_amount: dbBalance,
    on_chain_amount: liveBalance,
    diff,
    asset_type: campaign.asset_type,
  };

  logger.warn('[reconcile] raised_amount corrected to match on-chain balance', audit);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE campaigns
       SET raised_amount = $1,
           status = CASE
             WHEN $1 >= target_amount AND status IN ('active', 'funded') THEN 'funded'
             ELSE status
           END
       WHERE id = $2`,
      [liveBalance, campaign.id]
    );
    const stellarTxId = await insertReconciliationAdjustment(client, {
      campaignId: campaign.id,
      dbBalance,
      liveBalance,
      diff,
      assetType: campaign.asset_type,
    });
    await client.query('COMMIT');

    cache.invalidate(`campaigns:id:${campaign.id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidatePrefix('stats:');

    alertDiscrepancyIfNeeded(campaign.id, audit);

    return { updated: true, dbBalance, liveBalance, diff, stellar_transaction_id: stellarTxId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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
      logger.info('[reconcile] Skipping campaign due to pending withdrawal', {
        campaign_id: campaign.id,
      });
      return { skipped: true, reason: 'pending_withdrawal' };
    }

    const onChain = await getCampaignBalance(campaign.wallet_public_key);
    const liveBalance = parseFloat(onChain[campaign.asset_type] || '0');
    const dbBalance = parseFloat(campaign.raised_amount);

    if (!hasDiscrepancy(dbBalance, liveBalance)) {
      return { updated: false, dbBalance, liveBalance, diff: 0 };
    }

    return await applyReconciliationCorrection(campaign, dbBalance, liveBalance);
  } catch (err) {
    logger.error('[reconcile] Failed for campaign', {
      campaign_id: campaign.id,
      error: err.message,
    });
    throw err;
  }
}

async function reconcileCampaignBalances() {
  const startedAt = new Date().toISOString();
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount, target_amount, status
     FROM campaigns
     WHERE status IN ('active', 'funded')`
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
        summary.results.push({ campaign_id: campaign.id, skipped: true, reason: result.reason });
      } else if (result.updated) {
        summary.updated += 1;
        summary.results.push({
          campaign_id: campaign.id,
          updated: true,
          db_amount: result.dbBalance,
          on_chain_amount: result.liveBalance,
          diff: result.diff,
          stellar_transaction_id: result.stellar_transaction_id,
        });
      } else if (result.updated) {
        summary.updated += 1;
        summary.results.push({ campaign_id: campaign.id, updated: true, dbBalance: result.dbBalance, liveBalance: result.liveBalance });
      }
    } catch (err) {
      summary.errors += 1;
      summary.results.push({ campaign_id: campaign.id, error: err.message });
    }
  }

  if (summary.updated > 0 || summary.errors > 0) {
    logger.info('[reconcile] Batch reconciliation finished', summary);
  }

  return summary;
  summary.finished_at = new Date().toISOString();
  recordReconciliationRun(summary);
}

async function reconcileSingleCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount, target_amount, status
     FROM campaigns WHERE id = $1`,
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
  getReconciliationAlertThreshold,
  hasDiscrepancy,
  DISCREPANCY_EPSILON,
  getRecentReconciliationRuns,
  recordReconciliationRun,
};
