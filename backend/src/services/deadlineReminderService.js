const db = require('../config/database');
const logger = require('../config/logger');
const { sendCampaignDeadlineReminderEmail } = require('./emailService');

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
}

async function processRemindersForHoursLeft(hoursLeft) {
  // Look for campaigns that expire within the next `hoursLeft` hours
  // Down to `hoursLeft - 12` hours, so we have a wide window to catch them if the worker was down.
  // Deduplication in emailService ensures we don't double-send.
  const maxTime = new Date(Date.now() + hoursLeft * 60 * 60 * 1000);
  const minTime = new Date(Date.now() + (hoursLeft - 12) * 60 * 60 * 1000);

  const { rows: campaigns } = await db.query(
    `SELECT id, title, target_amount, raised_amount
     FROM campaigns
     WHERE status = 'active'
       AND raised_amount < target_amount
       AND deadline IS NOT NULL
       AND deadline <= $1
       AND deadline > $2`,
    [maxTime, minTime]
  );

  for (const campaign of campaigns) {
    const { rows: backers } = await db.query(
      `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
       FROM contributions c
       JOIN users u ON u.wallet_public_key = c.sender_public_key
       WHERE c.campaign_id = $1 AND u.email IS NOT NULL AND c.refunded = FALSE`,
      [campaign.id]
    );

    const campaignUrl = `${frontendBaseUrl()}/campaigns/${campaign.id}`;

    for (const backer of backers) {
      try {
        await sendCampaignDeadlineReminderEmail({
          to: backer.email,
          campaignId: campaign.id,
          hoursLeft,
          contributorName: backer.name,
          campaignTitle: campaign.title,
          campaignUrl,
          targetAmount: campaign.target_amount,
          raisedAmount: campaign.raised_amount,
        });
      } catch (err) {
        logger.error('Failed to send deadline reminder', { 
          email: backer.email, 
          campaignId: campaign.id,
          error: err.message 
        });
      }
    }
  }
}

async function sendDeadlineReminders() {
  try {
    await processRemindersForHoursLeft(48);
    await processRemindersForHoursLeft(12);
  } catch (err) {
    logger.error('Error in sendDeadlineReminders', { error: err.message });
  }
}

module.exports = {
  sendDeadlineReminders,
};
