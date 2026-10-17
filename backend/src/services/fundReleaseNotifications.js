const db = require('../config/database');
const logger = require('../config/logger');
const { createNotification } = require('./notifications');
const { sendContributorFundsReleasedEmail } = require('./emailService');

async function listContributors(campaignId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
     FROM contributions c
     JOIN users u ON u.wallet_public_key = c.sender_public_key
     WHERE c.campaign_id = $1
     ORDER BY u.id, c.created_at ASC`,
    [campaignId]
  );
  return rows;
}

function buildMessage({ campaignId, campaignTitle, amount, asset, usage, txHash }) {
  const bodyParts = [
    `${amount} ${asset} was released from this campaign.`,
    usage ? `Usage: ${usage}` : null,
    txHash ? `Transaction: ${txHash}` : null,
  ].filter(Boolean);

  return {
    type: 'funds_released',
    title: `${campaignTitle}: funds released`,
    body: bodyParts.join(' '),
    link: `/campaigns/${campaignId}`,
  };
}

async function notifyContributorFundRelease({
  campaignId,
  campaignTitle,
  amount,
  asset,
  txHash,
  usage,
  recipient,
  excludeUserIds = [],
}) {
  const contributors = await listContributors(campaignId);
  const excluded = new Set(excludeUserIds.filter(Boolean));
  const message = buildMessage({ campaignId, campaignTitle, amount, asset, usage, txHash });
  const campaignUrl = `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/campaigns/${campaignId}`;

  let notified = 0;
  await Promise.all(
    contributors
      .filter(contributor => !excluded.has(contributor.id))
      .map(async contributor => {
        try {
          await createNotification(contributor.id, message);
          if (contributor.email) {
            await sendContributorFundsReleasedEmail({
              to: contributor.email,
              dedupeKey: `funds_released:${campaignId}:${txHash || 'no-tx'}:${contributor.id}`,
              contributorName: contributor.name,
              campaignTitle,
              campaignUrl,
              amount,
              asset,
              txHash,
              usage,
              recipient,
            });
          }
          notified += 1;
        } catch (err) {
          logger.error('Contributor fund release notification failed', {
            campaign_id: campaignId,
            user_id: contributor.id,
            error: err.message,
          });
        }
      })
  );

  return notified;
}

module.exports = { notifyContributorFundRelease, buildMessage };
