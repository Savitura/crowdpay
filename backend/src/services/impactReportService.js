const db = require('../config/database');
const logger = require('../config/logger');
const { createNotification } = require('./notifications');

const crypto = require('crypto');

const IMPACT_CACHE_TTL_MS = 60 * 1000;
const IMPACT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const IMPACT_RATE_LIMIT_MAX = 30;
const impactCache = new Map();
const impactRateLimits = new Map();

/**
 * Creates a draft impact report for a completed campaign.
 * Only the campaign creator can create the report.
 * Campaign must be in 'completed' or 'funded' status.
 */
async function createImpactReport(input) {
  const {
    campaignId,
    creatorId,
    title,
    content,
    summary,
    images = [],
    videos = [],
    milestones = [],
  } = input;

  if (!campaignId || !creatorId || !title || !content) {
    throw new Error('Missing required fields: campaignId, creatorId, title, content');
  }

  // Verify campaign exists and is completed
  const { rows: campaigns } = await db.query(
    `SELECT id, creator_id, status FROM campaigns WHERE id = $1`,
    [campaignId]
  );

  if (!campaigns.length) {
    const error = new Error('Campaign not found');
    error.status = 404;
    throw error;
  }

  const campaign = campaigns[0];

  // Verify creatorId matches campaign.creator_id
  if (campaign.creator_id !== creatorId) {
    const error = new Error('Only the campaign creator can create an impact report');
    error.status = 403;
    throw error;
  }

  // Verify campaign is completed or funded
  if (!['completed', 'funded', 'in_progress'].includes(campaign.status)) {
    const error = new Error(
      `Cannot create impact report for campaign with status "${campaign.status}". Campaign must be completed or funded.`
    );
    error.status = 400;
    throw error;
  }

  // Check no report already exists (unique per campaign)
  const { rows: existingReports } = await db.query(
    `SELECT id FROM campaign_impact_reports WHERE campaign_id = $1`,
    [campaignId]
  );

  if (existingReports.length) {
    const error = new Error('An impact report already exists for this campaign');
    error.status = 409;
    throw error;
  }

  // Insert as draft
  const { rows } = await db.query(
    `INSERT INTO campaign_impact_reports
     (campaign_id, creator_id, title, content, summary, images, videos, milestones, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
     RETURNING id`,
    [
      campaignId,
      creatorId,
      title,
      content,
      summary || null,
      JSON.stringify(images),
      JSON.stringify(videos),
      JSON.stringify(milestones),
    ]
  );

  const reportId = rows[0].id;
  logger.info('Impact report created as draft', { reportId, campaignId, creatorId });

  return reportId;
}

/**
 * Publishes a draft report, notifying all contributors.
 * Awards impact badge to creator.
 */
async function publishImpactReport(reportId, creatorId) {
  if (!reportId || !creatorId) {
    throw new Error('Missing reportId or creatorId');
  }

  // Load report, verify creator owns it and status is draft
  const { rows: reports } = await db.query(
    `SELECT id, campaign_id, creator_id, title, summary, status FROM campaign_impact_reports WHERE id = $1`,
    [reportId]
  );

  if (!reports.length) {
    const error = new Error('Impact report not found');
    error.status = 404;
    throw error;
  }

  const report = reports[0];

  if (report.creator_id !== creatorId) {
    const error = new Error('Only the report creator can publish the report');
    error.status = 403;
    throw error;
  }

  if (report.status !== 'draft') {
    const error = new Error(`Report status is "${report.status}", expected "draft"`);
    error.status = 400;
    throw error;
  }

  // Set status = 'published', published_at = NOW()
  await db.query(
    `UPDATE campaign_impact_reports
     SET status = 'published', published_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [reportId]
  );

  // Award impact badge to creator
  await db.query(
    `INSERT INTO creator_impact_badges (user_id, campaign_id, report_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, campaign_id) DO NOTHING`,
    [creatorId, report.campaign_id, reportId]
  );

  // Fetch campaign title and all unique contributor user_ids
  const { rows: campaignRows } = await db.query(
    `SELECT title FROM campaigns WHERE id = $1`,
    [report.campaign_id]
  );

  const campaignTitle = campaignRows[0]?.title || 'Campaign';

  const { rows: contributorRows } = await db.query(
    `SELECT DISTINCT c.sender_public_key
     FROM contributions c
     WHERE c.campaign_id = $1 AND c.refunded = FALSE
     ORDER BY c.sender_public_key`,
    [report.campaign_id]
  );

  // Get user_ids for all contributors via their sender_public_key
  if (contributorRows.length > 0) {
    const publicKeys = contributorRows.map(r => r.sender_public_key);
    const { rows: userRows } = await db.query(
      `SELECT id FROM users WHERE wallet_public_key = ANY($1)`,
      [publicKeys]
    );

    const contributorUserIds = userRows.map(r => r.id);

    // Send notification to each contributor
    for (const userId of contributorUserIds) {
      try {
        await createNotification(userId, {
          type: 'impact_report_published',
          title: `${campaignTitle} published an impact report`,
          body: report.summary || 'See how your contribution made a difference.',
          link: `/campaigns/${report.campaign_id}#impact-report`,
        });
      } catch (err) {
        logger.error('Failed to send impact report notification', { userId, reportId, err: err.message });
      }
    }
  }

  logger.info('Impact report published', { reportId, campaignId: report.campaign_id, creatorId });
}

/**
 * Returns a published report for display on the campaign page.
 * Returns null if report is draft (not visible publicly).
 */
async function getImpactReport(campaignId) {
  if (!campaignId) {
    throw new Error('Missing campaignId');
  }

  const { rows } = await db.query(
    `SELECT id, campaign_id, creator_id, title, content, summary, status, published_at, 
            images, videos, milestones, views_count, created_at, updated_at
     FROM campaign_impact_reports
     WHERE campaign_id = $1 AND status = 'published'`,
    [campaignId]
  );

  if (!rows.length) {
    return null;
  }

  const report = rows[0];

  // Increment views count (non-blocking)
  db.query(
    `UPDATE campaign_impact_reports SET views_count = views_count + 1 WHERE id = $1`,
    [report.id]
  ).catch(err => logger.error('Failed to increment view count', { err: err.message }));

  return {
    id: report.id,
    campaignId: report.campaign_id,
    creatorId: report.creator_id,
    title: report.title,
    content: report.content,
    summary: report.summary,
    status: report.status,
    publishedAt: report.published_at,
    images: report.images || [],
    videos: report.videos || [],
    milestones: report.milestones || [],
    viewsCount: report.views_count,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
  };
}

/**
 * Returns a draft report for the creator to edit.
 * Draft reports are only visible to the creator.
 */
async function getDraftImpactReport(campaignId, creatorId) {
  if (!campaignId || !creatorId) {
    throw new Error('Missing campaignId or creatorId');
  }

  const { rows } = await db.query(
    `SELECT id, campaign_id, creator_id, title, content, summary, status, published_at, 
            images, videos, milestones, views_count, created_at, updated_at
     FROM campaign_impact_reports
     WHERE campaign_id = $1 AND status = 'draft'`,
    [campaignId]
  );

  if (!rows.length) {
    return null;
  }

  const report = rows[0];

  // Verify creator owns it
  if (report.creator_id !== creatorId) {
    const error = new Error('Only the report creator can view draft reports');
    error.status = 403;
    throw error;
  }

  return {
    id: report.id,
    campaignId: report.campaign_id,
    creatorId: report.creator_id,
    title: report.title,
    content: report.content,
    summary: report.summary,
    status: report.status,
    publishedAt: report.published_at,
    images: report.images || [],
    videos: report.videos || [],
    milestones: report.milestones || [],
    viewsCount: report.views_count,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
  };
}

/**
 * Updates a draft report before publishing.
 */
async function updateImpactReport(reportId, creatorId, updates) {
  if (!reportId || !creatorId) {
    throw new Error('Missing reportId or creatorId');
  }

  // Verify owner and status is draft
  const { rows: reports } = await db.query(
    `SELECT id, creator_id, status FROM campaign_impact_reports WHERE id = $1`,
    [reportId]
  );

  if (!reports.length) {
    const error = new Error('Impact report not found');
    error.status = 404;
    throw error;
  }

  const report = reports[0];

  if (report.creator_id !== creatorId) {
    const error = new Error('Only the report creator can update the report');
    error.status = 403;
    throw error;
  }

  if (report.status !== 'draft') {
    const error = new Error('Can only update draft reports');
    error.status = 400;
    throw error;
  }

  // Build update query
  const allowedFields = ['title', 'content', 'summary', 'images', 'videos', 'milestones'];
  const updateSet = [];
  const values = [reportId];
  let paramIndex = 2;

  for (const field of allowedFields) {
    if (field in updates) {
      let value = updates[field];
      if (['images', 'videos', 'milestones'].includes(field)) {
        value = JSON.stringify(value || []);
      }
      updateSet.push(`${field} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (!updateSet.length) {
    logger.info('No fields to update in impact report', { reportId });
    return;
  }

  updateSet.push(`updated_at = NOW()`);
  const query = `UPDATE campaign_impact_reports SET ${updateSet.join(', ')} WHERE id = $1`;

  await db.query(query, values);

  logger.info('Impact report updated', { reportId, creatorId, fields: Object.keys(updates) });
}

/**
 * Checks if creator has published an impact report for the given campaign.
 */
async function hasPublishedReport(campaignId) {
  if (!campaignId) {
    throw new Error('Missing campaignId');
  }

  const { rows } = await db.query(
    `SELECT COUNT(*) as count FROM campaign_impact_reports 
     WHERE campaign_id = $1 AND status = 'published'`,
    [campaignId]
  );

  return rows[0].count > 0;
}

function signImpactStats(stats, campaignId) {
  const privateKey = process.env.CROWDPAY_IMPACT_SIGNING_PRIVATE_KEY ||
    process.env.CROWDPAY_SIGNING_PRIVATE_KEY ||
    process.env.PLATFORM_SIGNING_PRIVATE_KEY;
  if (!privateKey) {
    return null;
  }

  const payload = {
    type: 'campaign_impact_summary',
    campaignId: campaignId || null,
    version: 1,
    stats,
    signedAt: new Date().toISOString(),
  };
  const payloadString = JSON.stringify(payload);
  const signer = crypto.createSign('sha256');
  signer.update(payloadString);
  signer.end();

  return {
    payload: payloadString,
    signature: signer.sign(privateKey, 'base64'),
    algorithm: 'sha256',
  };
}

function verifyImpactSignature(payload, signature, publicKey) {
  if (!payload || !signature || !publicKey) {
    return false;
  }

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const verifier = crypto.createVerify('sha256');
  verifier.update(payloadString);
  verifier.end();

  return verifier.verify(publicKey, signature, 'base64');
}

async function getCampaignImpact(campaignId, options = {}) {
  if (!campaignId) {
    throw new Error('Missing campaignId');
  }

  const requesterIp = options.ip || options.requesterIp;
  if (requesterIp) {
    const now = Date.now();
    const rateKey = `impact:${requesterIp}`;
    const hits = (impactRateLimits.get(rateKey) || []).filter(
      timestamp => now - timestamp < IMPACT_RATE_LIMIT_WINDOW_MS
    );
    if (hits.length >= IMPACT_RATE_LIMIT_MAX) {
      const error = new Error('Rate limit exceeded');
      error.status = 429;
      throw error;
    }
    hits.push(now);
    impactRateLimits.set(rateKey, hits);
  }

  const { rows: versionRows } = await db.query(
    `SELECT COALESCE(MAX(updated_at), MAX(created_at)) AS version
     FROM contributions
     WHERE campaign_id = $1`,
    [campaignId]
  );
  const version = versionRows[0]?.version ? new Date(versionRows[0].version).getTime() : 0;
  const cached = impactCache.get(campaignId);

  if (cached && cached.version === version && Date.now() - cached.fetchedAt < IMPACT_CACHE_TTL_MS) {
    return cached.stats;
  }

  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(amount), 0) AS total_raised,
       COUNT(*)::int AS contribution_count,
       COALESCE(AVG(amount), 0) AS average_contribution,
       COALESCE(MAX(amount), 0) AS largest_contribution,
       COUNT(DISTINCT sender_public_key)::int AS unique_contributor_count,
       COALESCE(MAX(currency), 'USD') AS currency
     FROM contributions
     WHERE campaign_id = $1 AND refunded = FALSE`,
    [campaignId]
  );

  const row = rows[0];
  const stats = {
    total_raised: Number(row.total_raised),
    contribution_count: row.contribution_count,
    average_contribution: Number(row.average_contribution),
    largest_contribution: Number(row.largest_contribution),
    unique_contributor_count: row.unique_contributor_count,
    currency: row.currency,
  };

  const signed = signImpactStats(stats, campaignId);
  const response = signed
    ? { ...stats, signature: signed }
    : { ...stats, signature: null };

  impactCache.set(campaignId, { stats: response, version, fetchedAt: Date.now() });
  return response;
}

module.exports = {
  createImpactReport,
  publishImpactReport,
  getImpactReport,
  getDraftImpactReport,
  updateImpactReport,
  hasPublishedReport,
  getCampaignImpact,
  signImpactStats,
  verifyImpactSignature,
};
