const db = require('../config/database');
const logger = require('../config/logger');
const { fetchGithubRepoStats } = require('./githubService');

/**
 * Refresh GitHub stats for all active campaigns with a github_repo_url
 */
async function refreshGithubStats() {
  logger.info('[githubStatsCron] Starting GitHub stats refresh');
  try {
    const { rows: campaigns } = await db.query(
      `SELECT id, github_repo_url 
       FROM campaigns 
       WHERE github_repo_url IS NOT NULL 
       AND status IN ('active', 'funded', 'in_progress')`
    );

    let updatedCount = 0;
    for (const campaign of campaigns) {
      const stats = await fetchGithubRepoStats(campaign.github_repo_url);
      if (stats) {
        await db.query(
          `UPDATE campaigns 
           SET campaign_github_stats = $1 
           WHERE id = $2`,
          [JSON.stringify(stats), campaign.id]
        );
        updatedCount++;
      }
    }

    logger.info(`[githubStatsCron] Finished refreshing stats. Updated ${updatedCount}/${campaigns.length} campaigns.`);
  } catch (error) {
    logger.error('[githubStatsCron] Error refreshing GitHub stats', { error: error.message });
  }
}

module.exports = {
  refreshGithubStats
};
