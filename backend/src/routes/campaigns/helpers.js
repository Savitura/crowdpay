// backend/src/routes/campaigns/helpers.js
'use strict';

const multer = require('multer');
const { Keypair } = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const { TtlCache } = require('../../utils/TtlCache');
const { stripHtml } = require('../../lib/sanitize');
const asyncHandler = require('../../utils/asyncHandler');
const {
  MILESTONE_LIMIT,
  MAX_UPLOAD_SIZE,
  ALLOWED_UPLOAD_MIME_TYPES,
} = require('../../config/constants');

const campaignsCache = new TtlCache(60_000);
const IMPACT_CACHE_TTL_MS = 60_000;
const MILESTONE_PERCENT_SCALE = 10000;

function createHelpers(deps = {}) {
  const db = deps.db || require('../../config/database');
  const stellarService = deps.stellarService || require('../../services/stellarService');
  const SUPPORTED_ASSETS = stellarService.getSupportedAssetCodes
    ? stellarService.getSupportedAssetCodes()
    : ['XLM', 'USDC'];

  async function computeCampaignImpact(campaignId) {
    const { rows } = await db.query(
      `SELECT
         camp.asset_type AS currency,
         COALESCE(SUM(c.amount), 0)::numeric AS total_raised,
         COUNT(c.id)::int AS contribution_count,
         COALESCE(AVG(c.amount), 0)::numeric AS average_contribution,
         COALESCE(MAX(c.amount), 0)::numeric AS largest_contribution,
         COUNT(DISTINCT c.sender_public_key)::int AS unique_contributor_count
       FROM campaigns camp
       LEFT JOIN contributions c ON c.campaign_id = camp.id
       WHERE camp.id = $1 AND camp.deleted_at IS NULL AND camp.is_hidden = FALSE
       GROUP BY camp.asset_type`,
      [campaignId]
    );

    if (!rows.length) return null;

    const row = rows[0];
    return {
      total_raised: Number(row.total_raised),
      contribution_count: row.contribution_count,
      average_contribution: Number(row.average_contribution),
      largest_contribution: Number(row.largest_contribution),
      unique_contributor_count: row.unique_contributor_count,
      currency: row.currency,
    };
  }

  function signImpactStats(stats) {
    const signedPayload = JSON.stringify(stats);
    const keypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
    return {
      signed_payload: signedPayload,
      signature: keypair.sign(Buffer.from(signedPayload)).toString('base64'),
      public_key: keypair.publicKey(),
    };
  }

  async function generateUniqueReferralCode(runner = db) {
    for (let i = 0; i < 10; i++) {
      const code = crypto.randomBytes(6).toString('base64url').slice(0, 8);
      const { rows } = await runner.query(
        'SELECT 1 FROM campaign_referrals WHERE referral_code = $1',
        [code]
      );
      if (!rows.length) return code;
    }
    throw new Error('Could not generate unique referral code');
  }

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

  function normalizeMilestonesInput(input) {
    if (input === null || input === undefined) return [];
    if (!Array.isArray(input)) {
      throw new Error('milestones must be an array');
    }
    if (input.length === 0) return [];
    if (input.length > MILESTONE_LIMIT) {
      throw new Error(`Campaigns can define at most ${MILESTONE_LIMIT} milestones`);
    }

    const normalized = input.map((milestone, index) => {
      const title = stripHtml(milestone?.title || '');
      const description = stripHtml(milestone?.description || '');
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

    const totalUnits = normalized.reduce(
      (sum, milestone) => sum + milestone.release_percentage_units,
      0
    );
    const expectedUnits = 100 * MILESTONE_PERCENT_SCALE;
    if (totalUnits > expectedUnits) {
      throw new Error('Milestone percentages must not exceed 100%');
    }
    if (totalUnits < expectedUnits) {
      throw new Error('Milestone percentages must sum to at least 100%');
    }

    return normalized;
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_SIZE },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype)) {
        return cb(new Error('Invalid image type. Only JPG, PNG and WEBP are allowed.'));
      }
      cb(null, true);
    },
  });

  return {
    campaignsCache,
    IMPACT_CACHE_TTL_MS,
    MILESTONE_PERCENT_SCALE,
    SUPPORTED_ASSETS,
    computeCampaignImpact,
    signImpactStats,
    generateUniqueReferralCode,
    requireCampaignMember,
    normalizeMilestonesInput,
    upload,
  };
}

module.exports = createHelpers;
module.exports.createHelpers = createHelpers;
