const router = require('express').Router();
const db = require('../config/database');
const { verifyUnsubscribeToken } = require('../utils/unsubscribeToken');

router.get('/unsubscribe', async (req, res) => {
  const { email, category, sig } = req.query;

  if (!verifyUnsubscribeToken({ email, category, sig })) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
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
