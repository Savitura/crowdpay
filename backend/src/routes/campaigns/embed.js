// backend/src/routes/campaigns/embed.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');

function createEmbedRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const logger = deps.logger || require('../../config/logger');
  const ogImageService = deps.ogImageService || require('../../services/ogImageService');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { generateCampaignOgImage } = ogImageService;
  const { campaignsCache, computeCampaignImpact } = helpers;

  const serveOgImage = asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.target_amount, c.raised_amount, c.asset_type, c.status, c.deleted_at,
              u.full_name AS creator_name, u.email AS creator_email
       FROM campaigns c
       LEFT JOIN users u ON u.id = c.creator_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length || rows[0].deleted_at) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = rows[0];
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const campaignUrl = `${frontendUrl}/campaigns/${campaign.id}`;
    const creatorName =
      campaign.creator_name ||
      (campaign.creator_email ? campaign.creator_email.split('@')[0] : 'Creator');

    const pngBuffer = await generateCampaignOgImage({
      title: campaign.title,
      creatorName,
      raisedAmount: campaign.raised_amount,
      targetAmount: campaign.target_amount,
      assetType: campaign.asset_type,
      campaignUrl,
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(pngBuffer);
  });

  function daysRemaining(deadline) {
    if (!deadline) return null;
    const end = new Date(deadline);
    end.setHours(23, 59, 59, 999);
    return Math.max(0, Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  }

  async function loadPublicCampaignSummary(campaignId) {
    const { rows } = await db.query(
      `SELECT id, title, description, target_amount, raised_amount, asset_type, status, deadline,
              (SELECT COUNT(*)::int FROM contributions c WHERE c.campaign_id = campaigns.id) AS backer_count
       FROM campaigns WHERE id = $1 AND deleted_at IS NULL AND is_hidden = FALSE`,
      [campaignId]
    );
    if (!rows.length) return null;

    const campaign = rows[0];
    const pct = campaign.target_amount
      ? Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100)
      : 0;

    return {
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      raised_amount: Number(campaign.raised_amount),
      target_amount: Number(campaign.target_amount),
      asset_type: campaign.asset_type,
      status: campaign.status,
      deadline: campaign.deadline,
      backer_count: campaign.backer_count,
      days_remaining: daysRemaining(campaign.deadline),
      progress_percentage: Math.round(pct * 10) / 10,
      contribution_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${campaign.id}`,
    };
  }

  const EMBED_MILESTONE_STATUS = {
    pending: 'pending',
    rejected: 'pending',
    pending_review: 'submitted',
    approved: 'approved',
    released: 'released',
  };

  async function loadPublicCampaignMilestones(campaignId) {
    const { rows } = await db.query(
      `SELECT id, title, release_percentage, sort_order, status
       FROM milestones
       WHERE campaign_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [campaignId]
    );

    return rows.map(milestone => ({
      id: milestone.id,
      title: milestone.title,
      release_percentage: Number(milestone.release_percentage),
      sort_order: milestone.sort_order,
      status: EMBED_MILESTONE_STATUS[milestone.status] || 'pending',
    }));
  }

  function summariseMilestones(milestones) {
    const released = milestones.filter(milestone => milestone.status === 'released');
    const releasedPercentage = released.reduce(
      (total, milestone) => total + milestone.release_percentage,
      0
    );

    return {
      total: milestones.length,
      released: released.length,
      approved: milestones.filter(milestone => milestone.status === 'approved').length,
      submitted: milestones.filter(milestone => milestone.status === 'submitted').length,
      pending: milestones.filter(milestone => milestone.status === 'pending').length,
      released_percentage: Math.round(releasedPercentage * 10) / 10,
    };
  }

  const WIDGET_DESCRIPTION_LENGTH = 200;
  const WIDGET_RECENT_BACKER_LIMIT = 3;

  function truncateWidgetDescription(description) {
    if (!description) return '';
    return description.length > WIDGET_DESCRIPTION_LENGTH
      ? `${description.slice(0, WIDGET_DESCRIPTION_LENGTH).trim()}...`
      : description;
  }

  async function loadWidgetRecentBackers(campaignId, { limit = WIDGET_RECENT_BACKER_LIMIT } = {}) {
    const { rows: campaignRows } = await db.query(
      'SELECT show_backer_amounts FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const showAmounts = campaignRows[0]?.show_backer_amounts !== false;

    const { rows } = await db.query(
      `SELECT ctr.display_name,
              ctr.amount,
              COALESCE(u.contributor_privacy, 'full') AS contributor_privacy
         FROM contributions ctr
         LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
        WHERE ctr.campaign_id = $1 AND ctr.status = 'completed'
        ORDER BY ctr.created_at DESC
        LIMIT $2`,
      [campaignId, limit]
    );

    return rows
      .map(row => {
        const privacy = row.contributor_privacy || 'full';
        const name = privacy === 'full' ? row.display_name || null : null;
        const amountVisible = showAmounts && privacy !== 'anonymous';
        const amount = amountVisible ? Number(row.amount) : null;
        if (!name && amount === null) return null;
        return { name: name || 'Anonymous', amount };
      })
      .filter(Boolean);
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildFundingBadgeSvg({ leftLabel, rightLabel }) {
    const leftWidth = Math.max(72, leftLabel.length * 7 + 18);
    const rightWidth = Math.max(100, rightLabel.length * 6.5 + 18);
    const totalWidth = leftWidth + rightWidth;

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(`${leftLabel}: ${rightLabel}`)}">`,
      `<linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fbfbfb"/><stop offset="1" stop-color="#f0f0f0"/></linearGradient>`,
      `<clipPath id="c"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>`,
      `<g clip-path="url(#c)">`,
      `<rect width="${leftWidth}" height="20" fill="#555"/>`,
      `<rect x="${leftWidth}" width="${rightWidth}" height="20" fill="#7c3aed"/>`,
      `<rect width="${totalWidth}" height="20" fill="url(#g)"/>`,
      `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">`,
      `<text x="${leftWidth / 2}" y="14">${escapeXml(leftLabel)}</text>`,
      `<text x="${leftWidth + rightWidth / 2}" y="14">${escapeXml(rightLabel)}</text>`,
      `</g></g></svg>`,
    ].join('');
  }

  router.get('/:id/og-image.png', serveOgImage);
  router.get('/:id/og-image', serveOgImage);

  router.get(
    '/:id/embed',
    asyncHandler(async (req, res) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type');

      const campaignId = req.params.id;
      const summary = await loadPublicCampaignSummary(campaignId);
      if (!summary) return res.status(404).json({ error: 'Campaign not found' });

      const milestones = await loadPublicCampaignMilestones(campaignId);
      const impact = await computeCampaignImpact(campaignId);

      res.json({
        ...summary,
        description:
          summary.description?.slice(0, 200) + (summary.description?.length > 200 ? '...' : ''),
        milestones,
        milestone_summary: summariseMilestones(milestones),
        impact,
      });
    })
  );

  router.get(
    '/:id/widget',
    asyncHandler(async (req, res) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type');

      const campaignId = req.params.id;
      const summary = await loadPublicCampaignSummary(campaignId);
      if (!summary) return res.status(404).json({ error: 'Campaign not found' });

      const milestones = await loadPublicCampaignMilestones(campaignId);
      const impact = await computeCampaignImpact(campaignId);
      const recentBackers = await loadWidgetRecentBackers(campaignId);

      // Widgets poll every 30s; a matching browser/CDN cache keeps embeds from
      // turning into a request storm on popular campaign pages.
      res.header('Cache-Control', 'public, max-age=30');

      res.json({
        id: summary.id,
        title: summary.title,
        description: truncateWidgetDescription(summary.description),
        raised_amount: summary.raised_amount,
        target_amount: summary.target_amount,
        asset_type: summary.asset_type,
        status: summary.status,
        contributor_count: summary.backer_count,
        days_remaining: summary.days_remaining,
        progress_percentage: summary.progress_percentage,
        contribution_url: summary.contribution_url,
        milestones,
        milestone_summary: summariseMilestones(milestones),
        recent_backers: recentBackers,
        impact,
      });
    })
  );

  router.get(
    '/:id/badge.svg',
    asyncHandler(async (req, res) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

      const campaignId = parseInt(req.params.id, 10);
      const summary = await loadPublicCampaignSummary(campaignId);
      if (!summary) return res.status(404).send('Campaign not found');

      const raisedLabel = `${summary.raised_amount.toLocaleString()} / ${summary.target_amount.toLocaleString()} ${summary.asset_type}`;
      const rightLabel = `${summary.progress_percentage}% - ${raisedLabel}`;
      const svg = buildFundingBadgeSvg({ leftLabel: 'CrowdPay', rightLabel });

      res.type('image/svg+xml').send(svg);
    })
  );

  return router;
}

module.exports = createEmbedRouter;
module.exports.createEmbedRouter = createEmbedRouter;
