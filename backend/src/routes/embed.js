const express = require('express');
const router = express.Router();
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const { embedStatsLimiter } = require('../middleware/rateLimiter');

router.get(
  '/:campaignId/stats',
  embedStatsLimiter,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;

    const campaignQuery = await db.query(
      `SELECT id, title, description, target_amount, raised_amount, asset_type,
              status, deadline, backer_count, contribution_url
       FROM campaigns WHERE id = $1`,
      [campaignId]
    );

    if (campaignQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignQuery.rows[0];

    const contributorsQuery = await db.query(
      `SELECT id, amount, created_at, contributor_name
       FROM contributions
       WHERE campaign_id = $1 AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 5`,
      [campaignId]
    );

    const milestonesQuery = await db.query(
      `SELECT id, title, release_percentage, status, sort_order
       FROM milestones
       WHERE campaign_id = $1
       ORDER BY sort_order ASC`,
      [campaignId]
    );

    const target = Number(campaign.target_amount) || 0;
    const raised = Number(campaign.raised_amount) || 0;
    const progressPercentage = target > 0 ? Math.min(100, (raised / target) * 100) : 0;

    let daysRemaining = null;
    if (campaign.deadline) {
      const diff = new Date(campaign.deadline) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    res.json({
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      target_amount: campaign.target_amount,
      raised_amount: campaign.raised_amount,
      asset_type: campaign.asset_type,
      status: campaign.status,
      backer_count: campaign.backer_count || contributorsQuery.rows.length,
      days_remaining: daysRemaining,
      progress_percentage: Number(progressPercentage.toFixed(1)),
      contribution_url: campaign.contribution_url || `${req.protocol}://${req.get('host')}/campaigns/${campaign.id}`,
      recent_backers: contributorsQuery.rows.map(c => ({
        id: c.id,
        amount: c.amount,
        name: c.contributor_name || 'Anonymous',
        created_at: c.created_at,
      })),
      milestones: milestonesQuery.rows,
    });
  })
);

module.exports = router;