const db = require('../config/database');
const logger = require('../config/logger');
const { triggerCampaignStatusActions } = require('./campaignStatusActions');

/**
 * Reconcile status for one campaign (active → funded or failed based on goal/deadline).
 */
async function refreshCampaignStatus(campaignId, client) {
  const runner = client || db;
  const { rows: failed } = await runner.query(
    `UPDATE campaigns
     SET status = 'failed'
     WHERE id = $1
       AND status = 'active'
       AND deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status, escrow_contract_id`,
    [campaignId]
  );

  const { rows: funded } = await runner.query(
    `UPDATE campaigns
     SET status = 'funded'
     WHERE id = $1
       AND status = 'active'
       AND raised_amount >= target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status, escrow_contract_id`,
    [campaignId]
  );

  if (failed[0]) {
    await triggerCampaignStatusActions(failed[0], 'active');
  }

  if (funded[0]) {
    await triggerCampaignStatusActions(funded[0], 'active');
  }

  return {
    failed: failed[0] || null,
    funded: funded[0] || null,
  };
}

/**
 * Batch refresh for all still-active campaigns (hourly cron).
 */
async function refreshActiveCampaignStatuses() {
  const { rows: funded } = await db.query(
    `UPDATE campaigns
     SET status = 'funded'
     WHERE status = 'active'
       AND raised_amount >= target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status, escrow_contract_id`
  );

  const { rows: failed } = await db.query(
    `UPDATE campaigns
     SET status = 'failed'
     WHERE status = 'active'
       AND deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status, escrow_contract_id`
  );

  if (funded.length || failed.length) {
    for (const campaign of funded) {
      await triggerCampaignStatusActions(campaign, 'active');
    }
    for (const campaign of failed) {
      await triggerCampaignStatusActions(campaign, 'active');
    }

    logger.info('Campaign status refresh completed', {
      funded_count: funded.length,
      failed_count: failed.length,
    });
  }

  return { funded, failed };
}

module.exports = {
  refreshCampaignStatus,
  refreshActiveCampaignStatuses,
};

