const router = require('express').Router();
const db = require('../config/database');
const { verifyUnsubscribeToken } = require('../utils/unsubscribeToken');

router.get('/unsubscribe', async (req, res) => {
  const { email, category, sig, campaign_id: campaignId } = req.query;

  if (!verifyUnsubscribeToken({ email, category, sig, campaign_id: campaignId })) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }

  if (campaignId) {
    await db.query(
      `INSERT INTO campaign_update_unsubscribes (email, campaign_id)
       VALUES ($1, $2)
       ON CONFLICT (email, campaign_id) DO NOTHING`,
      [String(email).toLowerCase(), Number(campaignId)]
    );
    return res.send('You have been unsubscribed from updates for this campaign.');
  }

  await db.query(
    `INSERT INTO email_unsubscribes (email, category)
     VALUES ($1, $2)
     ON CONFLICT (email, category) DO NOTHING`,
    [String(email).toLowerCase(), category]
  );

  res.send('You have been unsubscribed from these emails.');
});

module.exports = router;
