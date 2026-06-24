const router = require('express').Router();
const multer = require('multer');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createCampaignWallet,
  getCampaignBalance,
  getSupportedAssetCodes,
} = require('../services/stellarService');
const { Keypair } = require('@stellar/stellar-sdk');
const { encryptSecret } = require('../services/walletService');
const { watchCampaignWallet, addSSEClient, removeSSEClient } = require('../services/ledgerMonitor');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { refreshCampaignStatus, refreshActiveCampaignStatuses } = require('../services/campaignStatusService');
const { queueFailedCampaignRefunds } = require('../services/campaignStatusActions');
const { invokeContract, encodeMilestone, nativeToScVal } = require('../services/sorobanService');
const { sendEmail, sendTeamMemberInvitedEmail } = require('../services/emailService');
const { uploadCampaignCoverImage } = require('../services/storage');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const { listCreatorCampaigns } = require('../services/userDashboardService');
const {
  MAX_TIERS_PER_CAMPAIGN,
  validateTiersInput,
  insertTiers,
  listTiersWithAvailability,
} = require('../services/rewardTierService');
const {
  createCampaignValidation,
  createCampaignUpdateValidation,
  getCampaignsValidation,
  validateRequest,
} = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');
const {
  createCampaignInvite,
  resendCampaignInvite,
  cancelCampaignInvite,
  acceptCampaignInvite,
  countAcceptedOwners,
  resolveUserCampaignRole,
} = require('../services/campaignInviteService');
const {
  isValidRole,
  canEditCampaignContent,
  canViewAnalytics,
  canInviteMembers,
  canManageMembers,
  canChangeRoles,
} = require('../lib/campaignPermissions');

const crypto = require('crypto');

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, '').trim();
}

function generateReferralCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

/**
 * @openapi
 * tags:
 *   - name: Campaigns
 *     description: Campaign discovery and management
 */

const requireCampaignMember = (...allowedRoles) => {
  return asyncHandler(async (req, res, next) => {
    const campaignId = req.params.id || req.params.campaign_id || req.body.campaign_id;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required' });

    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRows[0];

    if (req.user.role === 'admin') {
      req.campaignRole = 'owner';
      return next();
    }

    const { rows: memberRows } = await db.query(
      'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [campaignId, req.user.userId]
    );

    let role = null;
    if (memberRows.length && memberRows[0].accepted_at) {
      role = memberRows[0].role;
    } else if (campaign.creator_id === req.user.userId) {
      role = 'owner';
    }

    if (!role || (allowedRoles.length && !allowedRoles.includes(role))) {
      return res.status(403).json({ error: 'Insufficient permissions for this campaign' });
    }

    req.campaignRole = role;
    next();
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid image type. Only JPG, PNG and WEBP are allowed.'));
    }
    cb(null, true);
  },
});

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const MILESTONE_PERCENT_SCALE = 10000;
const MILESTONE_LIMIT = 5;

function normalizeMilestonesInput(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error('milestones must be an array');
  }
  if (input.length === 0) return [];
  if (input.length > MILESTONE_LIMIT) {
    throw new Error(`Campaigns can define at most ${MILESTONE_LIMIT} milestones`);
  }

  const normalized = input.map((milestone, index) => {
    const title = String(milestone?.title || '').trim();
    const description = String(milestone?.description || '').trim();
    if (!title) {
      throw new Error(`Milestone ${index + 1} title is required`);
    }
    if (!description) {
      throw new Error(`Milestone ${index + 1} description is required`);
    }

    const releasePercentage = Number(milestone?.release_percentage);
    if (!Number.isFinite(releasePercentage) || releasePercentage <= 0) {
      throw new Error(`Milestone ${index + 1} release_percentage must be greater than zero`);
    }

    return {
      title,
      description,
      release_percentage: releasePercentage.toFixed(4),
      release_percentage_units: Math.round(releasePercentage * MILESTONE_PERCENT_SCALE),
      sort_order: index,
    };
  });

  const totalUnits = normalized.reduce((sum, milestone) => sum + milestone.release_percentage_units, 0);
  if (totalUnits !== 100 * MILESTONE_PERCENT_SCALE) {
    throw new Error('Milestone release percentages must sum to exactly 100%');
  }

  return normalized;
}

// List campaigns with optional search, filtering, sorting, and pagination
router.get('/', getCampaignsValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns:
   *   get:
   *     tags: [Campaigns]
   *     summary: List campaigns
   *     parameters:
   *       - in: query
   *         name: status
   *         schema: { type: string }
   *       - in: query
   *         name: asset
   *         schema: { type: string }
   *       - in: query
   *         name: search
   *         schema: { type: string }
   *       - in: query
   *         name: sort
   *         schema: { type: string }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 50 }
   *       - in: query
   *         name: offset
   *         schema: { type: integer, minimum: 0 }
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 total: { type: integer }
   *                 limit: { type: integer }
   *                 offset: { type: integer }
   *                 campaigns:
   *                   type: array
   *                   items:
   *                     type: object
   */
  const { search, status, asset, category, sort = 'newest' } = req.query;
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const filters = [];
  const params = [];

  // Exclude deleted campaigns from public listing
  filters.push(`c.deleted_at IS NULL`);

  if (status) {
    params.push(status);
    filters.push(`c.status = $${params.length}`);
  } else {
    filters.push(`c.status = 'active'`);
  }
  if (asset) {
    params.push(asset);
    filters.push(`c.asset_type = $${params.length}`);
  }
  if (category) {
    params.push(category);
    filters.push(`c.category = $${params.length}`);
  }
  if (search) {
    params.push(search);
    filters.push(`c.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const countQuery = `SELECT COUNT(*)::int AS total FROM campaigns c ${whereClause}`;
  const countResult = await db.query(countQuery, params);
  const total = countResult.rows[0]?.total || 0;

  const sortExpressions = {
    newest: 'c.created_at DESC',
    trending: `(SELECT COUNT(*) FROM contributions ctr WHERE ctr.campaign_id = c.id AND ctr.created_at >= NOW() - INTERVAL '48 hours') DESC`,
    ending_soon: 'c.deadline ASC NULLS LAST',
    most_funded: 'c.raised_amount DESC',
    most_backed: '(SELECT COUNT(*) FROM contributions ctr WHERE ctr.campaign_id = c.id) DESC',
    closest_to_goal: '(c.raised_amount / NULLIF(c.target_amount, 0)) DESC NULLS LAST, c.raised_amount DESC',
  };
  const orderBy = sortExpressions[sort] || sortExpressions.newest;

  const query = `
    SELECT c.*,
           u.name AS creator_name,
           u.kyc_status AS creator_kyc_status,
           (SELECT COUNT(*)::int FROM campaign_updates cu WHERE cu.campaign_id = c.id) AS updates_count,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions con WHERE con.campaign_id = c.id) AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;
  const result = await db.query(query, [...params, limit, offset]);

  res.json({ total, limit, offset, campaigns: result.rows });
}));

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listCreatorCampaigns(req.user.userId);
  res.json(campaigns);
}));

router.get('/:id/milestones', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.*, (c.milestones_contract_id IS NOT NULL) AS on_chain
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.post('/:id/milestones', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  let normalizedMilestones;
  try {
    normalizedMilestones = normalizeMilestonesInput(req.body?.milestones);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!normalizedMilestones.length) {
    return res.status(400).json({ error: 'At least one milestone is required' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: campaignRows } = await client.query(
      'SELECT id, creator_id, status FROM campaigns WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!campaignRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRows[0];
    if (campaign.creator_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the campaign creator can define milestones' });
    }
    if (!['active', 'funded', 'in_progress'].includes(campaign.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Milestones cannot be edited while campaign status is "${campaign.status}".` });
    }

    const { rows: existingRows } = await client.query(
      'SELECT status FROM milestones WHERE campaign_id = $1',
      [campaign.id]
    );
    if (existingRows.some((row) => row.status !== 'pending')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Milestone plan cannot be changed after approvals or releases begin' });
    }

    await client.query('DELETE FROM milestones WHERE campaign_id = $1', [campaign.id]);
    const inserted = [];
    for (const milestone of normalizedMilestones) {
      const { rows } = await client.query(
        `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          campaign.id,
          milestone.title,
          milestone.description,
          milestone.release_percentage,
          milestone.sort_order,
        ]
      );
      inserted.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Campaign milestone plan update failed', { campaign_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not save campaign milestones' });
  } finally {
    client.release();
  }
}));

// Get single Campaign
// Get featured campaigns
router.get('/featured', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
           c.asset_type, c.status, c.deadline, c.featured_note,
           u.name AS creator_name,
           (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    WHERE c.featured = TRUE AND c.status = 'active' AND c.deleted_at IS NULL
    ORDER BY c.featured_at DESC
    LIMIT 3
  `);
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns/{id}:
   *   get:
   *     tags: [Campaigns]
   *     summary: Get campaign by id
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *       404:
   *         description: Not found
   */
  const refCode = req.query.ref;
  if (refCode) {
    try {
      const { rows: referralRows } = await db.query(
        'SELECT id, campaign_id FROM campaign_referrals WHERE referral_code = $1 AND campaign_id = $2',
        [refCode, req.params.id]
      );
      if (referralRows.length) {
        await db.query(
          'UPDATE campaign_referrals SET click_count = click_count + 1 WHERE id = $1',
          [referralRows[0].id]
        );
        res.cookie(`cp_ref_${req.params.id}`, refCode, {
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: '/',
        });
      }
    } catch (err) {
      logger.warn('Referral click tracking failed', { campaign_id: req.params.id, ref: refCode, error: err.message });
    }
  }

  const query = `
    SELECT *,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions WHERE campaign_id = $1) AS contributor_count
    FROM campaigns
    WHERE id = $1
  `;
  await refreshCampaignStatus(req.params.id);
  const { rows } = await db.query(query, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  
  const campaign = rows[0];
  
  // Allow viewing suspended campaigns with a notice, but deleted campaigns are not accessible
  if (campaign.deleted_at) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  
  let userRole = null;

  const header = req.headers.authorization;
  const token =
    req.cookies?.cp_token ||
    (header && header.startsWith('Bearer ') ? header.slice(7).trim() : null);
  if (token && !token.startsWith('cp_live_')) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload && payload.userId) {
        if (payload.is_admin) {
          userRole = 'owner';
        } else if (campaign.creator_id === payload.userId) {
          userRole = 'owner';
        } else {
          userRole = await resolveUserCampaignRole(
            campaign.id,
            payload.userId,
            payload.role === 'admin'
          );
        }
      }
    } catch (err) {
      // Ignore invalid token for public route
    }
  }

  // Add notice if campaign is suspended
  const response = { ...campaign, user_role: userRole };
  if (campaign.status === 'suspended') {
    response.suspended_notice = 'This campaign has been suspended and cannot receive new contributions';
  }

  res.json(response);
}));

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
     FROM campaigns WHERE id = $1 AND deleted_at IS NULL`,
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

// Embeddable campaign widget data (public, with permissive CORS)
router.get('/:id/embed', asyncHandler(async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  const campaignId = parseInt(req.params.id, 10);
  const summary = await loadPublicCampaignSummary(campaignId);
  if (!summary) return res.status(404).json({ error: 'Campaign not found' });

  res.json({
    ...summary,
    description:
      summary.description?.slice(0, 200) + (summary.description?.length > 200 ? '...' : ''),
  });
}));

// Compact widget payload for lightweight iframe embeds
router.get('/:id/widget', asyncHandler(async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  const campaignId = parseInt(req.params.id, 10);
  const summary = await loadPublicCampaignSummary(campaignId);
  if (!summary) return res.status(404).json({ error: 'Campaign not found' });

  res.json({
    id: summary.id,
    title: summary.title,
    raised_amount: summary.raised_amount,
    target_amount: summary.target_amount,
    asset_type: summary.asset_type,
    status: summary.status,
    contributor_count: summary.backer_count,
    days_remaining: summary.days_remaining,
    progress_percentage: summary.progress_percentage,
    contribution_url: summary.contribution_url,
  });
}));

// SVG funding badge for README embedding (shields.io style)
router.get('/:id/badge.svg', asyncHandler(async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  const campaignId = parseInt(req.params.id, 10);
  const summary = await loadPublicCampaignSummary(campaignId);
  if (!summary) return res.status(404).send('Campaign not found');

  const raisedLabel = `${summary.raised_amount.toLocaleString()} / ${summary.target_amount.toLocaleString()} ${summary.asset_type}`;
  const rightLabel = `${summary.progress_percentage}% · ${raisedLabel}`;
  const svg = buildFundingBadgeSvg({ leftLabel: 'CrowdPay', rightLabel });

  res.type('image/svg+xml').send(svg);
}));

// Get backers for a campaign
router.get('/:id/backers', asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaignRows } = await db.query('SELECT show_backer_amounts FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
  const { show_backer_amounts } = campaignRows[0];

  const query = `
    SELECT 
      display_name,
      sender_public_key,
      ${show_backer_amounts ? 'amount,' : ''}
      asset,
      created_at
    FROM contributions
    WHERE campaign_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await db.query(query, [campaignId]);
  res.json(rows);
}));

// SSE stream for real-time campaign funding updates
router.get('/:id/stream', asyncHandler(async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('data: {"type":"connected"}\n\n');

  addSSEClient(campaignId, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSSEClient(campaignId, res);
  });
}));

// Get live on-chain balance for a campaign
router.get('/:id/balance', asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns/{id}/balance:
   *   get:
   *     tags: [Campaigns]
   *     summary: Get live on-chain balance for a campaign wallet
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   asset_type: { type: string }
   *                   balance: { type: string }
   *       404:
   *         description: Campaign not found
   */
  const { rows } = await db.query(
    'SELECT wallet_public_key FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json(balance);
}));

// Scheduled endpoint to fail expired campaigns and prevent further contributions
router.post('/cron/fail-expired', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { failed, funded } = await refreshActiveCampaignStatuses();
  res.json({ failedCampaigns: failed, fundedCampaigns: funded });
}));

// Scheduled endpoint to send 48h deadline reminders
router.post('/cron/reminders', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  // Find campaigns ending in exactly 2 days that are still active
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.deadline, u.email as creator_email
     FROM campaigns c
     JOIN users u ON c.creator_id = u.id
     WHERE c.status = 'active'
       AND c.deadline = CURRENT_DATE + INTERVAL '2 days'`
  );

  for (const campaign of rows) {
    sendEmail({
      to: campaign.creator_email,
      subject: `Reminder: Campaign "${campaign.title}" ends in 48 hours`,
      text: `Your campaign "${campaign.title}" is approaching its deadline on ${new Date(campaign.deadline).toDateString()}. 
If your target is reached, you can request a withdrawal. Otherwise, contributions will be refunded.`
    });
  }

  res.json({ remindersSent: rows.length });
}));

// Trigger refund withdrawal requests for a failed campaign
router.post('/:id/trigger-refunds', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaigns } = await db.query(
    `SELECT id, wallet_public_key, status FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];
  if (campaign.status !== 'failed') {
    return res.status(409).json({ error: 'Refunds may only be triggered for failed campaigns' });
  }

  try {
    const { refundsCreated, refunds } = await queueFailedCampaignRefunds(campaignId, req.user.userId);
    if (refundsCreated === 0) {
      return res.json({ refundsCreated: 0 });
    }
    res.status(201).json({ refundsCreated, refunds });
  } catch (err) {
    logger.error('Refund trigger failed', { campaign_id: campaignId, error: err.message });
    res.status(500).json({ error: 'Could not trigger refunds for campaign' });
  }
}));

// Create campaign (authenticated)
router.post('/', requireAuth, requireRole('creator', 'admin'), createCampaignValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns:
   *   post:
   *     tags: [Campaigns]
   *     summary: Create campaign
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [title, target_amount, asset_type]
   *             properties:
   *               title: { type: string }
   *               description: { type: string, nullable: true }
   *               target_amount: { type: string }
   *               asset_type: { type: string }
   *               deadline: { type: string, nullable: true }
   *               milestones: { type: array, items: { type: object }, nullable: true }
   *               min_contribution: { type: string, nullable: true }
   *               max_contribution: { type: string, nullable: true }
   *     responses:
   *       201:
   *         description: Created
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   */
  const { title, description, target_amount, asset_type, deadline, milestones, min_contribution, max_contribution, reward_tiers } = req.body;

  let normalizedMilestones;
  try {
    normalizedMilestones = normalizeMilestonesInput(milestones);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Reward tiers are optional. Validate up front (asset must match the campaign).
  let normalizedTiers;
  try {
    normalizedTiers = validateTiersInput(reward_tiers, asset_type);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Get creator's info
  const { rows: userRows } = await db.query(
    'SELECT email, wallet_public_key, kyc_status FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });
  
  if (isKycRequiredForCampaigns() && userRows[0].kyc_status !== 'verified') {
    return res.status(403).json({
      error: 'Verify your identity before creating a campaign.',
      code: 'KYC_REQUIRED',
      kyc_status: userRows[0].kyc_status,
    });
  }

  const creatorPublicKey = userRows[0].wallet_public_key;
  const creatorEmail = userRows[0].email;

  // 1. Create the on-chain campaign wallet
  const wallet = await createCampaignWallet(creatorPublicKey);

  // 2. Deploy Soroban contract instances
  const platformPublicKey = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY).publicKey();
  const platformFeeBps = parseInt(process.env.PLATFORM_FEE_BPS || '0', 10);
  const deadlineUnix = deadline ? Math.floor(new Date(deadline).getTime() / 1000) : 0;

  // Use a default asset contract address based on asset type. On testnet, the
  // USDC token contract address may differ from the issuer. We use the issuer
  // as a reasonable default for v1; production deployments should set
  // ASSET_CONTRACT_ADDRESS in env and populate it from the Stellar asset contract.
  const assetContractAddress = process.env.USDC_CONTRACT_ADDRESS || process.env.USDC_ISSUER;

  const { escrowContractId, milestonesContractId } = await deployCampaignContracts({
    creatorPublicKey,
    platformPublicKey,
    campaignId: req.body.title + Date.now(),
    targetAmount: Math.floor(parseFloat(target_amount) * 10_000_000),
    deadlineUnix,
    assetContractAddress,
    platformFeeBps,
    milestones: normalizedMilestones,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });

  const client = await db.connect();
  let campaign;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO campaigns
         (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline, 
          min_contribution, max_contribution, escrow_contract_id, milestones_contract_id, platform_fee_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [title, description, target_amount, asset_type, wallet.publicKey, req.user.userId, deadline, 
       min_contribution || null, max_contribution || null, escrowContractId, milestonesContractId, platformFeeBps]
    );
    campaign = rows[0];

    await client.query(
      `INSERT INTO campaign_members
         (campaign_id, user_id, email, role, accepted_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [campaign.id, req.user.userId, creatorEmail, 'owner']
    );

    for (const milestone of normalizedMilestones) {
      await client.query(
        `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          campaign.id,
          milestone.title,
          milestone.description,
          milestone.release_percentage,
          milestone.sort_order,
        ]
      );
    }

    if (normalizedTiers.length) {
      await insertTiers(client, campaign.id, normalizedTiers);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[campaigns] DB insert failed after wallet creation. Orphaned wallet:', {
      publicKey: wallet.publicKey,
      creatorUserId: req.user.userId,
      error: err.message,
    });
    return res.status(500).json({
      error: 'Campaign could not be saved. Wallet creation may have succeeded — contact support.',
    });
  } finally {
    client.release();
  }

  watchCampaignWallet(campaign.id, wallet.publicKey);

  res.status(201).json(campaign);
}));

/**
 * @openapi
 * /api/campaigns/{id}/tiers:
 *   get:
 *     tags: [Campaigns]
 *     summary: List a campaign's reward tiers with remaining availability
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: List of reward tiers }
 *       404: { description: Campaign not found }
 */
router.get('/:id/tiers', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const tiers = await listTiersWithAvailability(req.params.id);
  res.json(tiers);
}));

/**
 * @openapi
 * /api/campaigns/{id}/tiers:
 *   post:
 *     tags: [Campaigns]
 *     summary: Add one or more reward tiers to an existing campaign (creator only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201: { description: Updated list of reward tiers }
 *       400: { description: Invalid input or tier cap exceeded }
 *       403: { description: Forbidden }
 *       404: { description: Campaign not found }
 */
router.post('/:id/tiers', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const campaignId = req.params.id;

  const { rows: campaignRows } = await db.query('SELECT asset_type FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
  const assetType = campaignRows[0].asset_type;

  // Accept either a single tier object or an array of tiers.
  const input = Array.isArray(req.body) ? req.body : [req.body];
  let normalizedTiers;
  try {
    normalizedTiers = validateTiersInput(input, assetType);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!normalizedTiers.length) {
    return res.status(400).json({ error: 'At least one reward tier is required' });
  }

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM reward_tiers WHERE campaign_id = $1',
    [campaignId]
  );
  if (countRows[0].n + normalizedTiers.length > MAX_TIERS_PER_CAMPAIGN) {
    return res.status(400).json({
      error: `A campaign can have at most ${MAX_TIERS_PER_CAMPAIGN} reward tiers`,
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await insertTiers(client, campaignId, normalizedTiers);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[campaigns] add reward tiers failed', { error: err.message });
    return res.status(500).json({ error: 'Could not add reward tiers' });
  } finally {
    client.release();
  }

  const tiers = await listTiersWithAvailability(campaignId);
  res.status(201).json(tiers);
}));

// PATCH /campaigns/:id - Update campaign (title, description, deadline)
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { title, description, deadline } = req.body;

  // Check if campaign exists and belongs to user
  const { rows: campaignRows } = await db.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaignRows.length) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const campaign = campaignRows[0];
  const userRole = await resolveUserCampaignRole(campaignId, req.user.userId, req.user.role === 'admin');
  if (!canEditCampaignContent(userRole)) {
    return res.status(403).json({ error: 'You do not have permission to edit this campaign' });
  }

  // Refresh campaign status to check current state
  await refreshCampaignStatus(campaignId);

  const { rows: updatedStatusRows } = await db.query(
    'SELECT status FROM campaigns WHERE id = $1',
    [campaignId]
  );
  const currentStatus = updatedStatusRows[0].status;

  // Only allow editing active or funded campaigns
  if (!['active', 'funded'].includes(currentStatus)) {
    return res.status(422).json({
      error: `Cannot edit a campaign with status: ${currentStatus}`
    });
  }

  // Validate and prepare update object
  const updates = {};
  const updateParams = [];
  let paramIndex = 1;

  if (title !== undefined) {
    const cleanTitle = stripHtml(title);
    if (!cleanTitle) {
      return res.status(422).json({ error: 'Title cannot be empty' });
    }
    if (cleanTitle.length > 100) {
      return res.status(422).json({ error: 'Title must be at most 100 characters' });
    }
    updates.title = cleanTitle;
    updateParams.push(['title', cleanTitle, `$${paramIndex++}`]);
  }

  if (description !== undefined) {
    const cleanDesc = stripHtml(description);
    if (cleanDesc.length > 1000) {
      return res.status(422).json({ error: 'Description must be at most 1000 characters' });
    }
    updates.description = cleanDesc;
    updateParams.push(['description', cleanDesc, `$${paramIndex++}`]);
  }

  if (deadline !== undefined && deadline !== null && deadline !== '') {
    // Validate ISO8601 format
    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) {
      return res.status(422).json({ error: 'Deadline must be a valid date' });
    }

    // Check deadline is not in the past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    deadlineDate.setHours(0, 0, 0, 0);

    if (deadlineDate < today) {
      return res.status(422).json({ error: 'Deadline cannot be in the past' });
    }

    updates.deadline = deadline;
    updateParams.push(['deadline', deadline, `$${paramIndex++}`]);
  }

  // Check if any valid updates were provided
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // Check for invalid fields in request body
  const allowedFields = ['title', 'description', 'deadline'];
  for (const field of Object.keys(req.body)) {
    if (!allowedFields.includes(field)) {
      return res.status(422).json({
        error: `Cannot update field: ${field}`
      });
    }
  }

  // Build and execute update query
  const setClause = updateParams.map(([field, , placeholder]) => `${field} = ${placeholder}`).join(', ');
  const values = updateParams.map(([, value]) => value);
  values.push(campaignId);

  const query = `
    UPDATE campaigns
    SET ${setClause}
    WHERE id = $${paramIndex}
    RETURNING *
  `;

  const { rows: updatedRows } = await db.query(query, values);
  if (!updatedRows.length) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  res.json(updatedRows[0]);
}));

router.post(
  '/:id/cover-image',
  requireAuth,
  requireCampaignMember('owner', 'editor'),
  (req, res, next) => {
    upload.single('cover_image')(req, res, (err) => {
      if (err) {
        return res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message || 'Invalid cover image upload',
            fields: { cover_image: err.message || 'Invalid file' },
          },
        });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'cover_image is required',
          fields: { cover_image: 'No image uploaded' },
        },
      });
    }

    try {
      const coverImageUrl = await uploadCampaignCoverImage(req.params.id, req.file);
      const { rows: updatedRows } = await db.query(
        'UPDATE campaigns SET cover_image_url = $1 WHERE id = $2 RETURNING *',
        [coverImageUrl, req.params.id]
      );
      res.json(updatedRows[0]);
    } catch (err) {
      return res.status(500).json({ error: 'Could not upload campaign cover image' });
    }
  }
);

router.get('/:id/updates', asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await db.query(
    `SELECT cu.id, cu.campaign_id, cu.author_id, cu.title, cu.body, cu.created_at, u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset]
  );
  res.json(rows);
}));

router.post('/:id/updates', requireAuth, requireCampaignMember('owner', 'manager'), createCampaignUpdateValidation, validateRequest, asyncHandler(async (req, res) => {
  const { title, body } = req.body;

  const { rows } = await db.query(
    `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, campaign_id, author_id, title, body, created_at`,
    [req.params.id, req.user.userId, title.trim(), body.trim()]
  );
  res.status(201).json(rows[0]);
}));

// POST /campaigns/:id/members/invite — owner/manager invites by email (7-day token)
router.post('/:id/members/invite', requireAuth, requireCampaignMember('owner', 'manager'), asyncHandler(async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(422).json({ error: 'Email and role are required' });
  if (!isValidRole(role)) {
    return res.status(422).json({ error: 'Invalid role. Must be owner, manager, editor, or viewer' });
  }

  const { rows: campaignRows } = await db.query('SELECT title FROM campaigns WHERE id = $1', [req.params.id]);
  const { member } = await createCampaignInvite({
    campaignId: req.params.id,
    email,
    role,
    invitedByUserId: req.user.userId,
    campaignTitle: campaignRows[0]?.title,
  });
  res.status(201).json(member);
}));

// GET /campaigns/:id/members — team list (owner/manager)
router.get('/:id/members', requireAuth, requireCampaignMember('owner', 'manager'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT cm.id, cm.user_id, cm.email, cm.role, cm.accepted_at, cm.created_at,
            cm.invite_expires_at,
            u.name AS user_name
     FROM campaign_members cm
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.campaign_id = $1
     ORDER BY cm.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
}));

// PATCH /campaigns/:id/members/:userId — change role (owner only)
router.patch('/:id/members/:userId', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!role || !isValidRole(role)) {
    return res.status(422).json({ error: 'Invalid role. Must be owner, manager, editor, or viewer' });
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET role = $1
     WHERE campaign_id = $2 AND user_id = $3 AND accepted_at IS NOT NULL
     RETURNING id, campaign_id, user_id, role, accepted_at`,
    [role, req.params.id, req.params.userId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Member not found' });
  }

  res.json(rows[0]);
}));

// POST /campaigns/:id/members/:memberId/resend — resend pending invite
router.post('/:id/members/:memberId/resend', requireAuth, requireCampaignMember('owner', 'manager'), asyncHandler(async (req, res) => {
  const { rows: campaignRows } = await db.query('SELECT title FROM campaigns WHERE id = $1', [req.params.id]);
  const { member } = await resendCampaignInvite({
    memberId: req.params.memberId,
    campaignId: req.params.id,
    campaignTitle: campaignRows[0]?.title,
  });
  res.json(member);
}));

// DELETE /campaigns/:id/members/invites/:memberId — cancel pending invite
router.delete('/:id/members/invites/:memberId', requireAuth, requireCampaignMember('owner', 'manager'), asyncHandler(async (req, res) => {
  await cancelCampaignInvite({
    memberId: req.params.memberId,
    campaignId: req.params.id,
  });
  res.json({ cancelled: true });
}));

// DELETE /campaigns/:id/members/:userId — remove member (owner) or leave team
router.delete('/:id/members/:userId', requireAuth, asyncHandler(async (req, res) => {
  const memberUserId = req.params.userId;
  const isSelf = String(memberUserId) === String(req.user.userId);

  const actorRole = await resolveUserCampaignRole(
    req.params.id,
    req.user.userId,
    req.user.role === 'admin'
  );

  if (!isSelf && !canManageMembers(actorRole)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { rows: targetRows } = await db.query(
    `SELECT role, accepted_at FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2`,
    [req.params.id, memberUserId]
  );

  if (!targetRows.length) {
    return res.status(404).json({ error: 'Member not found' });
  }

  if (targetRows[0].role === 'owner' && targetRows[0].accepted_at) {
    const ownerCount = await countAcceptedOwners(req.params.id);
    if (ownerCount <= 1) {
      return res.status(409).json({ error: 'Cannot remove the last owner from the campaign team' });
    }
  }

  const { rows } = await db.query(
    `DELETE FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2
     RETURNING id`,
    [req.params.id, memberUserId]
  );

  res.json({ message: 'Member removed successfully', id: rows[0].id });
}));

// POST /campaigns/:id/members/accept — accept invitation (token in body, legacy)
router.post('/:id/members/accept', requireAuth, asyncHandler(async (req, res) => {
  const { token: inviteToken } = req.body;
  if (!inviteToken) return res.status(422).json({ error: 'Invitation token is required' });

  const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
  const member = await acceptCampaignInvite({
    inviteToken,
    userId: req.user.userId,
    userEmail: userRows[0]?.email,
  });
  res.json(member);
}));

const { getCampaignAnalytics, getCampaignContributors } = require('../services/analyticsService');

// GET /campaigns/:id/analytics — full contribution analytics
router.get('/:id/analytics', asyncHandler(async (req, res) => {
  const data = await getCampaignAnalytics(req.params.id);
  if (!data) return res.status(404).json({ error: 'Campaign not found' });
  res.json(data);
}));

// GET /campaigns/:id/analytics/contributors — country breakdown, repeat vs first-time
router.get('/:id/analytics/contributors', requireAuth, asyncHandler(async (req, res) => {
  // verify campaign exists and requester is owner or admin
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (req.user.role !== 'admin' && rows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const data = await getCampaignContributors(req.params.id);
  res.json(data);
}));

// GET /campaigns/:id/referral — get or create a referral code for the authenticated user
router.get('/:id/referral', requireAuth, asyncHandler(async (req, res) => {
  const { rows: existing } = await db.query(
    `SELECT cr.id, cr.referral_code, cr.click_count, cr.contribution_count
     FROM campaign_referrals cr
     WHERE cr.campaign_id = $1 AND cr.referrer_user_id = $2`,
    [req.params.id, req.user.userId]
  );

  if (existing.length) {
    const row = existing[0];
    return res.json({
      referral_code: row.referral_code,
      referral_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}?ref=${row.referral_code}`,
      click_count: row.click_count,
      contribution_count: row.contribution_count,
    });
  }

  const code = generateReferralCode();
  const { rows: inserted } = await db.query(
    `INSERT INTO campaign_referrals (campaign_id, referrer_user_id, referral_code)
     VALUES ($1, $2, $3)
     RETURNING referral_code, click_count, contribution_count`,
    [req.params.id, req.user.userId, code]
  );
  const row = inserted[0];
  res.status(201).json({
    referral_code: row.referral_code,
    referral_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}?ref=${row.referral_code}`,
    click_count: row.click_count,
    contribution_count: row.contribution_count,
  });
}));

// GET /campaigns/:id/referrals — creator only; list top referrers
router.get('/:id/referrals', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT cr.referral_code, cr.click_count, cr.contribution_count, cr.created_at,
            u.name AS referrer_name, u.id AS referrer_id
     FROM campaign_referrals cr
     JOIN users u ON u.id = cr.referrer_user_id
     WHERE cr.campaign_id = $1
     ORDER BY cr.contribution_count DESC, cr.click_count DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

module.exports = router;
