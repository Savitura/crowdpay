const router = require('express').Router();
const db = require('../config/database');
const { verifyUnsubscribeToken } = require('../utils/unsubscribeToken');
const { isUuid } = require('../utils/validation');
const asyncHandler = require('../utils/asyncHandler');

router.get('/unsubscribe', asyncHandler(async (req, res) => {
  const { email, category, sig, campaign_id: campaignId } = req.query;

  if (campaignId !== undefined && !isUuid(campaignId)) {
    return res.status(400).json({ error: 'Invalid campaign_id.' });
  }

  if (!verifyUnsubscribeToken({ email, category, sig, campaign_id: campaignId })) {
    return res.status(400).json({ error: 'Invalid or expired unsubscribe link.' });
  }

  // Handle specific old overrides
  if (category === 'thank_you') {
    const existing = await db.query(
      `SELECT 1 FROM thank_you_unsubscribes
       WHERE email = $1 ${campaignId ? 'AND campaign_id = $2' : 'AND campaign_id IS NULL'}
       LIMIT 1`,
      campaignId ? [String(email).toLowerCase(), campaignId] : [String(email).toLowerCase()]
    );
    if (!existing.rows.length) {
      await db.query(
        `INSERT INTO thank_you_unsubscribes (email, campaign_id) VALUES ($1, $2)`,
        [String(email).toLowerCase(), campaignId || null]
      );
    }
    return res.json({ success: true, message: 'Unsubscribed from thank-you messages.' });
  }

  if (campaignId && category === 'campaign_update') {
    await db.query(
      `INSERT INTO campaign_update_unsubscribes (email, campaign_id)
       VALUES ($1, $2)
       ON CONFLICT (email, campaign_id) DO NOTHING`,
      [String(email).toLowerCase(), campaignId]
    );
    return res.json({ success: true, message: 'Unsubscribed from updates for this campaign.' });
  }

  const { rows: users } = await db.query(
    "SELECT id FROM users WHERE email = $1",
    [String(email).toLowerCase()]
  );

  if (users.length > 0) {
    let mappedCategory = category;
    if (category === 'campaign_update') mappedCategory = 'campaign_updates';
    else if (category === 'weekly_digest') mappedCategory = 'marketing';
    else if (category === 'refund') mappedCategory = 'refunds';
    else if (category === 'dispute') mappedCategory = 'disputes';
    else if (category === 'milestone') mappedCategory = 'milestones';

    const validCategories = ['campaign_updates', 'refunds', 'disputes', 'milestones', 'marketing'];
    if (validCategories.includes(mappedCategory)) {
      await db.query(
        `INSERT INTO notification_preferences (user_id, campaign_updates, refunds, disputes, milestones, marketing)
         VALUES ($1, TRUE, TRUE, TRUE, TRUE, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET
           ${mappedCategory} = FALSE,
           updated_at = NOW()`,
        [users[0].id]
      );
    }
  }

  // Fallback to legacy tracking for non-users or unmapped categories
  await db.query(
    `INSERT INTO email_unsubscribes (email, category)
     VALUES ($1, $2)
     ON CONFLICT (email, category) DO NOTHING`,
    [String(email).toLowerCase(), category]
  );

  res.json({ success: true, message: 'Unsubscribed successfully.' });
}));

module.exports = router;
