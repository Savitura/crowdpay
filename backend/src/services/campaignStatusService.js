const db = require('../config/database');
const logger = require('../config/logger');

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
     RETURNING id, title, target_amount, raised_amount, deadline, status`,
    [campaignId]
  );

  const { rows: funded } = await runner.query(
    `UPDATE campaigns
     SET status = 'funded'
     WHERE id = $1
       AND status = 'active'
       AND raised_amount >= target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`,
    [campaignId]
  );

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
     RETURNING id, title, target_amount, raised_amount, deadline, status`
  );

  const { rows: failed } = await db.query(
    `UPDATE campaigns
     SET status = 'failed'
     WHERE status = 'active'
       AND deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`
  );

  if (funded.length || failed.length) {
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
