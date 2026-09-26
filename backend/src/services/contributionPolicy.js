const db = require('../config/database');

async function assertContributionPolicy(campaign, destinationAmount, senderPublicKey) {
  const amount = parseFloat(destinationAmount);
  if (isNaN(amount) || amount <= 0) {
    const err = new Error('Contribution amount must be greater than zero');
    err.statusCode = 422;
    throw err;
  }

  if (campaign.deadline) {
    const deadline = new Date(campaign.deadline);
    // Add 24h to deadline to allow contributions on the final day, or strict time?
    // Using simple strict comparison for now.
    if (deadline.getTime() < Date.now()) {
      const err = new Error('Campaign deadline has passed');
      err.statusCode = 400;
      throw err;
    }
  }

  if (campaign.min_contribution && amount < parseFloat(campaign.min_contribution)) {
    const err = new Error(`Contribution amount is below the minimum of ${campaign.min_contribution}`);
    err.statusCode = 400;
    throw err;
  }

  if (campaign.max_contribution && amount > parseFloat(campaign.max_contribution)) {
    const err = new Error(`Contribution amount exceeds the maximum of ${campaign.max_contribution}`);
    err.statusCode = 400;
    throw err;
  }

  if (campaign.max_per_user && senderPublicKey) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total
       FROM contributions
       WHERE campaign_id = $1 AND sender_public_key = $2 AND refunded = FALSE`,
      [campaign.id, senderPublicKey]
    );
    const totalSoFar = parseFloat(rows[0].total) || 0;
    if (totalSoFar + amount > parseFloat(campaign.max_per_user)) {
      const err = new Error(`Contribution exceeds the per-contributor cap of ${campaign.max_per_user}`);
      err.statusCode = 400;
      throw err;
    }
  }
}

module.exports = {
  assertContributionPolicy,
};
