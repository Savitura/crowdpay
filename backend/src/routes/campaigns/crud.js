// backend/src/routes/campaigns/crud.js
'use strict';

const express = require('express');
const Sentry = require('@sentry/node');
const { Keypair } = require('@stellar/stellar-sdk');
const asyncHandler = require('../../utils/asyncHandler');
const cache = require('../../utils/cache');
const withTransaction = require('../../utils/withTransaction');
const { resolveCampaignLanguage } = require('../../utils/campaignLocale');
const { stripHtml } = require('../../lib/sanitize');
const { getSimhash, simhashSimilarity } = require('../../utils/simhash');
const { toStroops } = require('../../utils/stroops');
const {
  PUBLIC_CAMPAIGN_SELECT,
  publicCampaignColumnList,
  stripInternalCampaignFields,
} = require('../../lib/publicCampaignColumns');
const { WEBHOOK_EVENTS } = require('../../services/webhookDispatcher');

function createCrudRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const logger = deps.logger || require('../../config/logger');
  const auth = deps.auth || require('../../middleware/auth');
  const stellarService = deps.stellarService || require('../../services/stellarService');
  const campaignStatusService =
    deps.campaignStatusService || require('../../services/campaignStatusService');
  const sorobanService = deps.sorobanService || require('../../services/sorobanService');
  const storage = deps.storage || require('../../services/storage');
  const kycProvider = deps.kycProvider || require('../../services/kycProvider');
  const campaignPublishing =
    deps.campaignPublishing || require('../../services/campaignPublishing');
  const rewardTierService = deps.rewardTierService || require('../../services/rewardTierService');
  const validation = deps.validation || require('../../middleware/validation');
  const campaignInviteService =
    deps.campaignInviteService || require('../../services/campaignInviteService');
  const campaignPermissions = deps.campaignPermissions || require('../../lib/campaignPermissions');
  const ledgerMonitor = deps.ledgerMonitor || require('../../services/ledgerMonitor');
  const walletService = deps.walletService || require('../../services/walletService');
  const webhookDispatcher = deps.webhookDispatcher || require('../../services/webhookDispatcher');
  const emailService = deps.emailService || require('../../services/emailService');
  const alerting = deps.alerting || require('../../services/alerting');
  const campaignFacetService =
    deps.campaignFacetService || require('../../services/campaignFacetService');
  const invalidateCampaignFacets =
    deps.invalidateCampaignFacets || campaignFacetService.invalidateCampaignFacets;
  const moderationAuditService =
    deps.moderationAuditService || require('../../services/moderationAuditService');
  const recordModerationAction =
    deps.recordModerationAction || moderationAuditService.recordModerationAction;
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth, requireRole, optionalAuth } = auth;
  const { sendEmail } = emailService;
  const { sendAlert } = alerting;
  const {
    createCampaignWallet,
    getCampaignBalance,
    getSupportedAssetCodes,
    revokeAndCloseCampaignWallet,
  } = stellarService;
  const { encryptSecret } = walletService;
  const { watchCampaignWallet, addSSEClient, removeSSEClient, cleanupStreamForWallet } =
    ledgerMonitor;
  const { emitWebhookEventForUser } = webhookDispatcher;
  const { refreshCampaignStatus, refreshActiveCampaignStatuses } = campaignStatusService;
  const {
    invokeContract,
    encodeMilestone,
    nativeToScVal,
    deployCampaignContracts,
    getContractStatus,
  } = sorobanService;
  const { uploadCampaignCoverImage } = storage;
  const { isKycRequiredForCampaigns, getTierLimit, VERIFICATION_TIER_LIMITS } = kycProvider;
  const { publishDraftCampaign, CampaignNotPublishableError } = campaignPublishing;
  const { MAX_TIERS_PER_CAMPAIGN, validateTiersInput, insertTiers, listTiersWithAvailability } =
    rewardTierService;
  const {
    createCampaignValidation,
    updateCampaignValidation,
    validateRequest,
    createValidateRequest,
  } = validation;
  const { resolveUserCampaignRole } = campaignInviteService;
  const {
    canEditCampaignContent,
    canViewAnalytics,
    canInviteMembers,
    canManageMembers,
    canChangeRoles,
    canAssignRole,
  } = campaignPermissions;
  const { SUPPORTED_ASSETS, upload, normalizeMilestonesInput, requireCampaignMember } = helpers;

  router.get(
    '/:id/clone-data',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;

      const { rows: campaignRows } = await db.query(
        `SELECT title, description, target_amount, asset_type, category, min_contribution, max_contribution, max_per_user, show_backer_amounts
     FROM campaigns 
     WHERE id = $1`,
        [campaignId]
      );

      if (!campaignRows.length) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const campaign = campaignRows[0];

      const { rows: milestones } = await db.query(
        `SELECT title, description, release_percentage
     FROM milestones 
     WHERE campaign_id = $1 
     ORDER BY sort_order ASC`,
        [campaignId]
      );

      const { rows: reward_tiers } = await db.query(
        `SELECT title, description, min_amount, "limit", estimated_delivery
     FROM reward_tiers 
     WHERE campaign_id = $1
     ORDER BY min_amount ASC`,
        [campaignId]
      );

      res.json({
        title: `Copy of ${campaign.title}`,
        description: campaign.description,
        target_amount: campaign.target_amount,
        asset_type: campaign.asset_type,
        category: campaign.category,
        min_contribution: campaign.min_contribution,
        max_contribution: campaign.max_contribution,
        max_per_user: campaign.max_per_user,
        show_backer_amounts: campaign.show_backer_amounts,
        milestones: milestones,
        reward_tiers: reward_tiers,
      });
    })
  );

  // One-click clone: copies fields, milestones, and reward tiers into a new
  // draft campaign with no on-chain wallet/contracts yet (instant, no gas cost).

  router.post(
    '/:id/clone',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const sourceId = req.params.id;

      const { rows: campaignRows } = await db.query(
        `SELECT title, description, target_amount, asset_type, category,
            min_contribution, max_contribution, max_per_user, show_backer_amounts
     FROM campaigns WHERE id = $1`,
        [sourceId]
      );
      if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
      const source = campaignRows[0];

      const { rows: milestoneRows } = await db.query(
        'SELECT title, description, release_percentage, sort_order FROM milestones WHERE campaign_id = $1 ORDER BY sort_order ASC',
        [sourceId]
      );
      const { rows: tierRows } = await db.query(
        'SELECT title, description, min_amount, asset_type, tier_limit, estimated_delivery FROM reward_tiers WHERE campaign_id = $1 ORDER BY min_amount ASC',
        [sourceId]
      );

      const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [
        req.user.userId,
      ]);
      const creatorEmail = userRows[0]?.email;

      let clone;
      try {
        clone = await withTransaction(async client => {
          const { rows } = await client.query(
            `INSERT INTO campaigns
           (title, description, target_amount, asset_type, creator_id, status,
            category, min_contribution, max_contribution, max_per_user, show_backer_amounts,
            raised_amount, cloned_from)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, 0, $11)
         RETURNING *`,
            [
              `${source.title} (Copy)`,
              source.description,
              source.target_amount,
              source.asset_type,
              req.user.userId,
              source.category,
              source.min_contribution,
              source.max_contribution,
              source.max_per_user,
              source.show_backer_amounts,
              sourceId,
            ]
          );
          const createdClone = rows[0];

          await client.query(
            `INSERT INTO campaign_members (campaign_id, user_id, email, role, accepted_at)
           VALUES ($1, $2, $3, 'owner', NOW())`,
            [createdClone.id, req.user.userId, creatorEmail]
          );

          for (const milestone of milestoneRows) {
            await client.query(
              `INSERT INTO milestones (campaign_id, title, description, release_percentage, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
              [
                createdClone.id,
                milestone.title,
                milestone.description,
                milestone.release_percentage,
                milestone.sort_order,
              ]
            );
          }

          if (tierRows.length) {
            await insertTiers(
              client,
              createdClone.id,
              tierRows.map(t => ({
                title: t.title,
                description: t.description,
                min_amount: t.min_amount,
                asset_type: t.asset_type,
                tier_limit: t.tier_limit,
                estimated_delivery: t.estimated_delivery,
              }))
            );
          }

          return createdClone;
        }, db);
      } catch (err) {
        logger.error('[campaigns] clone failed', {
          source_campaign_id: sourceId,
          error: err.message,
        });
        return res.status(500).json({ error: 'Could not clone campaign' });
      }

      res.status(201).json(clone);
    })
  );

  // Schedule (or clear) auto-publish for a draft campaign.

  router.post(
    '/:id/schedule-publish',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { scheduled_publish_at } = req.body || {};

      const { rows: campaignRows } = await db.query('SELECT status FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
      if (campaignRows[0].status !== 'draft') {
        return res
          .status(409)
          .json({ error: 'Only draft campaigns can be scheduled for publishing' });
      }

      let value = null;
      if (scheduled_publish_at) {
        const date = new Date(scheduled_publish_at);
        if (isNaN(date.getTime())) {
          return res
            .status(422)
            .json({ error: 'scheduled_publish_at must be a valid ISO 8601 date' });
        }
        if (date.getTime() <= Date.now()) {
          return res.status(422).json({ error: 'scheduled_publish_at must be in the future' });
        }
        value = date.toISOString();
      }

      const { rows } = await db.query(
        'UPDATE campaigns SET scheduled_publish_at = $1 WHERE id = $2 RETURNING *',
        [value, req.params.id]
      );
      res.json(rows[0]);
    })
  );

  // Deploy the on-chain wallet + contracts for a draft campaign and make it active.

  router.post(
    '/:id/publish',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      try {
        const campaign = await publishDraftCampaign(req.params.id);
        res.json(campaign);
      } catch (err) {
        if (err instanceof CampaignNotPublishableError) {
          return res.status(409).json({ error: err.message });
        }
        logger.error('[campaigns] publish failed', {
          campaign_id: req.params.id,
          error: err.message,
        });
        res.status(502).json({ error: 'Could not publish campaign', detail: err.message });
      }
    })
  );

  // Get single Campaign
  // Get featured campaigns

  router.post(
    '/:id/favorite',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows: campaigns } = await db.query('SELECT id FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });

      await db.query(
        `INSERT INTO contributor_favorites (user_id, campaign_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, campaign_id) DO NOTHING`,
        [req.user.userId, req.params.id]
      );
      res.status(204).send();
    })
  );

  // DELETE /campaigns/:id - Soft-delete campaign (owner only) and revoke/close Stellar wallet

  router.delete(
    '/:id',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { id } = req.params;

      const { rows: campaignRows } = await db.query(
        'SELECT id, title, creator_id, wallet_public_key, wallet_secret_encrypted FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (!campaignRows.length) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const campaign = campaignRows[0];

      // Revoke platform multisig, sweep non-zero funds to platform, and close Stellar account
      try {
        await revokeAndCloseCampaignWallet(campaign);
      } catch (stellarErr) {
        logger.error(
          'Failed to revoke platform multisig / close Stellar account for deleted campaign',
          {
            campaignId: id,
            error: stellarErr.message,
          }
        );
        await sendAlert('Campaign wallet cleanup failed on deletion', {
          campaignId: id,
          walletPublicKey: campaign.wallet_public_key,
          error: stellarErr.message,
        });
        return res.status(502).json({
          error: 'Failed to revoke Stellar wallet multisig and close account',
          details: stellarErr.message,
        });
      }

      // Cleanup ledger stream registry and reconnect attempts for this wallet
      cleanupStreamForWallet(campaign.wallet_public_key);

      const { rows: updated } = await db.query(
        `UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 RETURNING id, title, deleted_at`,
        [id]
      );

      logger.info('Campaign deleted by owner', { campaignId: id, userId: req.user.userId });
      cache.invalidate(`campaigns:id:${id}`);
      cache.invalidatePrefix('campaigns:list:');
      invalidateCampaignFacets();
      res.json({ message: 'Campaign deleted', campaign: updated[0] });
    })
  );

  // Remove campaign from the current user's favorites/wishlist

  router.delete(
    '/:id/favorite',
    requireAuth,
    asyncHandler(async (req, res) => {
      await db.query('DELETE FROM contributor_favorites WHERE user_id = $1 AND campaign_id = $2', [
        req.user.userId,
        req.params.id,
      ]);
      res.status(204).send();
    })
  );

  router.get(
    '/:id/contract-status',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT id, contract_address, escrow_contract_id, milestones_contract_id,
            target_amount, deadline, status,
            contract_deployment_status, contract_deployment_error
     FROM campaigns
     WHERE id = $1`,
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const campaign = rows[0];
      const escrowContractId = campaign.escrow_contract_id || campaign.contract_address;

      if (!escrowContractId && !campaign.milestones_contract_id) {
        return res.json({
          has_contract: false,
          contract_deployment_status: campaign.contract_deployment_status,
          contract_deployment_error: campaign.contract_deployment_error,
          status: campaign.status,
          totalRaised: 0,
          milestones: [],
        });
      }

      try {
        const deadlineUnix = campaign.deadline
          ? Math.floor(new Date(campaign.deadline).getTime() / 1000)
          : 0;
        const targetAmount = toStroops(campaign.target_amount);

        const onChain = await getContractStatus({
          escrowContractId,
          milestonesContractId: campaign.milestones_contract_id,
          deadlineUnix,
          targetAmount,
        });

        res.json({
          has_contract: true,
          contract_address: campaign.contract_address || escrowContractId,
          escrow_contract_id: escrowContractId,
          milestones_contract_id: campaign.milestones_contract_id,
          contract_deployment_status: campaign.contract_deployment_status,
          ...onChain,
        });
      } catch (err) {
        logger.error('Failed to read on-chain contract status', {
          campaign_id: req.params.id,
          error: err.message,
        });
        res.status(502).json({
          error: 'Could not read on-chain contract status',
          detail: err.message,
        });
      }
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const rawLocale = req.query.locale || req.query.lang;
      const requestedLocale = rawLocale ? resolveCampaignLanguage(rawLocale) : null;
      if (rawLocale && !requestedLocale) {
        return res.status(400).json({ error: 'Unsupported campaign locale' });
      }

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
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              maxAge: 30 * 24 * 60 * 60 * 1000,
              path: '/',
            });
          }
        } catch (err) {
          logger.warn('Referral click tracking failed', {
            campaign_id: req.params.id,
            ref: refCode,
            error: err.message,
          });
        }
      }

      const shareSource = req.query.source || req.query.utm_source;
      if (shareSource && typeof shareSource === 'string') {
        res.cookie(`cp_share_source_${req.params.id}`, shareSource.slice(0, 64), {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: '/',
        });
      }

      const query = `
    SELECT ${PUBLIC_CAMPAIGN_SELECT},
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions WHERE campaign_id = $1) AS contributor_count,
           u.kyc_status AS creator_kyc_status,
           u.verification_status AS creator_verification_status,
           u.verification_tier AS creator_verification_tier
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    WHERE c.id = $1
  `;
      await refreshCampaignStatus(req.params.id);
      const { rows } = await db.query(query, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

      const campaign = rows[0];

      // Handle locale translation if requested (#753)
      if (requestedLocale) {
        try {
          const { rows: translationRows } = await db.query(
            `SELECT title, description, milestone_titles, COALESCE(locale, language) AS locale
         FROM campaign_translations
         WHERE campaign_id = $1 AND (locale = $2 OR language = $2)
         LIMIT 1`,
            [req.params.id, requestedLocale]
          );
          if (translationRows.length > 0) {
            const translation = translationRows[0];
            campaign.title = translation.title || campaign.title;
            if (translation.description !== null && translation.description !== undefined) {
              campaign.description = translation.description;
            }
            if (translation.milestone_titles) {
              campaign.milestone_titles = translation.milestone_titles;
            }
            campaign.locale = translation.locale;
            campaign.is_translated = true;
          }
        } catch (err) {
          logger.warn('Failed to load campaign translation', {
            campaign_id: req.params.id,
            locale: requestedLocale,
            error: err.message,
          });
        }
      }

      // Allow viewing suspended campaigns with a notice, but deleted campaigns are not accessible
      if (campaign.deleted_at) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      let userRole = null;

      const header = req.headers.authorization;
      const token =
        req.cookies?.cp_token ||
        (header && header.startsWith('Bearer ') ? header.slice(7).trim() : null);
      if (token && !token.startsWith('cpk_')) {
        try {
          const jwt = require('jsonwebtoken');
          const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
          if (payload && payload.userId) {
            const { rows: userRows } = await db.query('SELECT is_admin FROM users WHERE id = $1', [
              payload.userId,
            ]);
            const currentIsAdmin = userRows[0]?.is_admin === true;

            if (currentIsAdmin) {
              userRole = 'owner';
            } else if (campaign.creator_id === payload.userId) {
              userRole = 'owner';
            } else {
              userRole = await resolveUserCampaignRole(campaign.id, payload.userId, false);
            }
          }
        } catch (err) {
          // Ignore invalid token for public route
        }
      }

      // Hidden campaigns only accessible by owner or admin
      if (campaign.is_hidden && userRole !== 'owner') {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      // Add notice if campaign is suspended. `stripInternalCampaignFields` keeps
      // the public detail payload free of fraud/duplicate internals and the
      // encrypted wallet key even though the row is fetched with a wide allowlist.
      const response = { ...stripInternalCampaignFields(campaign), user_role: userRole };
      if (campaign.status === 'suspended') {
        response.suspended_notice =
          'This campaign has been suspended and cannot receive new contributions';
      }

      const baseUrl =
        process.env.BACKEND_URL ||
        (req.get('host') ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');
      const frontendBase = process.env.FRONTEND_URL || 'http://localhost:5173';
      response.og_image_url = `${baseUrl}/api/campaigns/${campaign.id}/og-image.png`;
      response.share_url = `${frontendBase}/campaigns/${campaign.id}`;

      res.json(response);
    })
  );

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

  // The embed widget speaks in four milestone states (#596). Internally a
  // milestone awaiting platform review is `pending_review`, and a rejected one is
  // back in the creator's hands, so both collapse to a public-facing state.
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

  /**
   * Public "recent backers" strip for the embeddable campaign progress widget.
   *
   * The widget is rendered on third-party sites, so this applies the same two
   * privacy gates as the authenticated backers list (#897): the campaign-level
   * `show_backer_amounts` flag and each contributor's `contributor_privacy`
   * preference. Anonymous contributors are never named, and `amount_only`
   * contributors never leak a display name.
   */
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

  // Embeddable campaign widget data (public, with permissive CORS)

  router.get(
    '/:id/stream',
    asyncHandler(async (req, res) => {
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
    })
  );

  // Get live on-chain balance for a campaign

  router.get(
    '/:id/balance',
    asyncHandler(async (req, res) => {
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
      const { rows } = await db.query('SELECT wallet_public_key FROM campaigns WHERE id = $1', [
        req.params.id,
      ]);
      if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
      const balance = await getCampaignBalance(rows[0].wallet_public_key);
      res.json(balance);
    })
  );

  // Scheduled endpoint to fail expired campaigns and prevent further contributions

  router.post(
    '/cron/fail-expired',
    requireAuth,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const { failed, funded } = await refreshActiveCampaignStatuses();
      res.json({ failedCampaigns: failed, fundedCampaigns: funded });
    })
  );

  // Scheduled endpoint to send 48h deadline reminders

  router.post(
    '/cron/reminders',
    requireAuth,
    requireRole('admin'),
    asyncHandler(async (req, res) => {
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
If your target is reached, you can request a withdrawal. Otherwise, contributions will be refunded.`,
        });
      }

      res.json({ remindersSent: rows.length });
    })
  );

  // Trigger refund withdrawal requests for a failed campaign

  router.post(
    '/check-duplicate',
    requireAuth,
    requireRole('creator', 'admin'),
    asyncHandler(async (req, res) => {
      const { title, description } = req.body;
      if (!title) return res.json({ isDuplicate: false });

      const contentFingerprint = getSimhash(`${title} ${description || ''}`);
      const { rows: existingCampaigns } = await db.query(
        'SELECT id, title, content_fingerprint FROM campaigns WHERE content_fingerprint IS NOT NULL AND status != $1',
        ['failed']
      );

      for (const c of existingCampaigns) {
        if (simhashSimilarity(contentFingerprint, c.content_fingerprint) > 0.9) {
          return res.json({ isDuplicate: true, similarTo: c.title });
        }
      }

      res.json({ isDuplicate: false });
    })
  );

  // Create campaign (authenticated)

  router.post(
    '/',
    requireAuth,
    requireRole('creator', 'admin'),
    createCampaignValidation,
    validateRequest,
    asyncHandler(async (req, res) => {
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
       *               category: { type: string, nullable: true }
       *     responses:
       *       201:
       *         description: Created
       *       401:
       *         description: Unauthorized
       *       403:
       *         description: Forbidden
       */
      const {
        title,
        description,
        target_amount,
        asset_type,
        deadline,
        milestones,
        min_contribution,
        max_contribution,
        reward_tiers,
        template_id,
        category,
        country,
      } = req.body;
      const normalizedCountry =
        typeof country === 'string' && country.trim() ? country.trim().slice(0, 80) : null;

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

      if (template_id) {
        const { rows: templateRows } = await db.query(
          'SELECT id FROM campaign_templates WHERE id = $1 AND is_active = TRUE',
          [template_id]
        );
        if (!templateRows.length) {
          return res.status(400).json({ error: 'Selected campaign template is unavailable' });
        }
      }

      // Get creator's info
      const { rows: userRows } = await db.query(
        'SELECT email, wallet_public_key, kyc_status, verification_status, verification_tier FROM users WHERE id = $1',
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

      // Tier-based campaign goal limit
      if (isKycRequiredForCampaigns()) {
        const userTier = userRows[0].verification_tier || 'none';
        const tierLimit = getTierLimit(userTier);
        const goalAmount = parseFloat(target_amount);

        if (tierLimit === 0 && userTier === 'none') {
          return res.status(403).json({
            error: 'Verify your identity before creating a campaign.',
            code: 'KYC_REQUIRED',
            verification_tier: userTier,
          });
        }

        if (goalAmount > tierLimit) {
          const upgradePath =
            userTier === 'basic'
              ? 'Upgrade to Standard verification (ID + address) to run campaigns up to $50,000.'
              : userTier === 'standard'
                ? 'Upgrade to Enhanced verification (ID + address + liveness) for unlimited campaign goals.'
                : 'Complete identity verification to create campaigns.';
          return res.status(403).json({
            error: `Campaign goal of $${goalAmount.toLocaleString()} exceeds your ${userTier} tier limit of $${tierLimit.toLocaleString()}.`,
            code: 'TIER_LIMIT_EXCEEDED',
            tier_limit: tierLimit,
            verification_tier: userTier,
            upgrade_path: upgradePath,
          });
        }
      }

      const creatorPublicKey = userRows[0].wallet_public_key;
      const creatorEmail = userRows[0].email;

      const contentFingerprint = getSimhash(`${title} ${description || ''}`);
      let isFlaggedDuplicate = false;

      const { rows: existingCampaigns } = await db.query(
        'SELECT content_fingerprint FROM campaigns WHERE content_fingerprint IS NOT NULL AND status != $1',
        ['failed']
      );

      for (const c of existingCampaigns) {
        if (simhashSimilarity(contentFingerprint, c.content_fingerprint) > 0.9) {
          isFlaggedDuplicate = true;
          break;
        }
      }

      // Generate the campaign keypair locally before any on-chain or DB writes.
      // This gives us the wallet_public_key for the DB record without a network call,
      // eliminating the risk of an orphaned Stellar wallet if the DB insert fails.
      const campaignKeypair = Keypair.random();
      const walletPublicKey = campaignKeypair.publicKey();

      // Deploy Soroban contract instances
      const platformPublicKey = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY).publicKey();
      const platformFeeBps = parseInt(process.env.PLATFORM_FEE_BPS || '0', 10);
      const deadlineUnix = deadline ? Math.floor(new Date(deadline).getTime() / 1000) : 0;

      // Use a default asset contract address based on asset type. On testnet, the
      // USDC token contract address may differ from the issuer. We use the issuer
      // as a reasonable default for v1; production deployments should set
      // ASSET_CONTRACT_ADDRESS in env and populate it from the Stellar asset contract.
      const assetContractAddress = process.env.USDC_CONTRACT_ADDRESS || process.env.USDC_ISSUER;

      let escrowContractId = null;
      let milestonesContractId = null;
      let contractDeploymentStatus;
      let contractDeploymentError = null;
      let campaignStatus = 'active';
      try {
        ({ escrowContractId, milestonesContractId } = await deployCampaignContracts({
          creatorPublicKey,
          platformPublicKey,
          campaignId: req.body.title + Date.now(),
          targetAmount: toStroops(target_amount),
          deadlineUnix,
          assetContractAddress,
          platformFeeBps,
          milestones: normalizedMilestones,
          signerSecret: process.env.PLATFORM_SECRET_KEY,
        }));
        contractDeploymentStatus = 'deployed';
      } catch (err) {
        logger.error('Soroban contract deployment failed during campaign creation', {
          error: err.message,
          creatorUserId: req.user.userId,
        });
        contractDeploymentStatus = 'failed';
        contractDeploymentError = err.message;
        // Never activate a campaign with missing/failed contract wiring (#809).
        campaignStatus = 'draft';
        escrowContractId = null;
        milestonesContractId = null;

        Sentry.withScope(scope => {
          scope.setLevel('error');
          scope.setTag('campaign_creation', 'contract_deployment');
          scope.setContext('deployment', {
            creatorUserId: req.user.userId,
            error: err.message,
          });
          Sentry.captureMessage(
            `Contract deployment failed during campaign creation: ${err.message}`
          );
        });
      }
      const contractAddress = escrowContractId || null;

      // Insert the campaign DB record BEFORE creating the Stellar wallet so that
      // a DB failure never leaves an untracked (orphaned) on-chain wallet.
      const client = await db.connect();
      let campaign;
      try {
        await client.query('BEGIN');
        if (template_id) {
          const { rows: templateRows } = await client.query(
            'SELECT id FROM campaign_templates WHERE id = $1 AND is_active = TRUE FOR UPDATE',
            [template_id]
          );
          if (!templateRows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Selected campaign template is unavailable' });
          }
        }
        const { rows } = await client.query(
          `INSERT INTO campaigns
         (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline, 
          min_contribution, max_contribution, escrow_contract_id, milestones_contract_id, platform_fee_bps,
          contract_address, contract_deployed_at, content_fingerprint, is_flagged_duplicate,
          contract_deployment_status, contract_deployment_error, last_deployment_attempt_at, template_id, category, country,
          status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       RETURNING ${publicCampaignColumnList('')}`,
          [
            title,
            description,
            target_amount,
            asset_type,
            walletPublicKey,
            req.user.userId,
            deadline,
            min_contribution || null,
            max_contribution || null,
            escrowContractId,
            milestonesContractId,
            platformFeeBps,
            contractAddress,
            contractDeploymentStatus === 'deployed' ? new Date() : null,
            contentFingerprint,
            isFlaggedDuplicate,
            contractDeploymentStatus,
            contractDeploymentError,
            new Date(),
            template_id || null,
            category || null,
            normalizedCountry,
            campaignStatus,
          ]
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

        if (template_id) {
          await client.query(
            'UPDATE campaign_templates SET use_count = use_count + 1, updated_at = NOW() WHERE id = $1',
            [template_id]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('[campaigns] DB insert failed during campaign creation', {
          creatorUserId: req.user.userId,
          error: err.message,
        });
        return res.status(500).json({ error: 'Campaign could not be saved.' });
      } finally {
        client.release();
      }

      // Now create the Stellar wallet on-chain. The DB record already exists, so
      // even if this fails we have tracked state and can retry later.
      try {
        await createCampaignWallet(creatorPublicKey, campaignKeypair);
      } catch (err) {
        logger.error(
          '[campaigns] Stellar wallet creation failed after DB insert. Campaign orphaned:',
          {
            campaign_id: campaign.id,
            publicKey: walletPublicKey,
            error: err.message,
          }
        );
        // Best-effort cleanup: mark the campaign so support can investigate
        await db
          .query(
            `UPDATE campaigns SET contract_deployment_status = 'failed', contract_deployment_error = $2 WHERE id = $1`,
            [campaign.id, `Wallet creation failed: ${err.message}`]
          )
          .catch(() => {});
        return res.status(500).json({
          error: 'Campaign saved but wallet creation failed. Please contact support.',
        });
      }

      watchCampaignWallet(campaign.id, walletPublicKey);
      invalidateCampaignFacets();

      // The creation response is the campaign row the creator just wrote: never
      // echo internal columns (content_fingerprint, fraud_*, wallet key) back.
      res.status(201).json(stripInternalCampaignFields(campaign));
    })
  );

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

  router.patch(
    '/:id',
    requireAuth,
    updateCampaignValidation,
    createValidateRequest(422),
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;

      // Check if campaign exists and belongs to user
      const { rows: campaignRows } = await db.query(
        `SELECT ${publicCampaignColumnList('')} FROM campaigns WHERE id = $1`,
        [campaignId]
      );
      if (!campaignRows.length) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const campaign = campaignRows[0];
      const userRole = await resolveUserCampaignRole(
        campaignId,
        req.user.userId,
        req.user.role === 'admin'
      );
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
          error: `Cannot edit a campaign with status: ${currentStatus}`,
        });
      }

      // Prepare update object from validated body
      const updates = {};
      const updateParams = [];
      let paramIndex = 1;

      const allowedFields = [
        'title',
        'category',
        'description',
        'target_amount',
        'deadline',
        'country',
        'min_contribution',
        'max_contribution',
        'max_per_user',
      ];

      for (const field of allowedFields) {
        const value = req.body[field];
        if (value === undefined) continue;

        if (field === 'title') {
          const cleanTitle = stripHtml(value);
          if (!cleanTitle) {
            return res.status(422).json({ error: 'Title cannot be empty' });
          }
          updates.title = cleanTitle;
          updateParams.push(['title', cleanTitle, `$${paramIndex++}`]);
        } else if (field === 'category') {
          const cleanCategory = stripHtml(value);
          updates.category = cleanCategory ? cleanCategory.slice(0, 50) : null;
          updateParams.push(['category', updates.category, `$${paramIndex++}`]);
        } else if (field === 'description') {
          const cleanDesc = stripHtml(value);
          updates.description = cleanDesc;
          updateParams.push(['description', cleanDesc, `$${paramIndex++}`]);
        } else if (field === 'target_amount') {
          const newTarget = Number(value);
          // Validate budget constraints
          const { rows: budgetRows } = await db.query(
            `SELECT SUM(amount) as total_budget FROM campaign_budget_categories WHERE campaign_id = $1`,
            [campaignId]
          );
          const totalBudget = Number(budgetRows[0].total_budget || 0);

          if (totalBudget > 0 && Math.abs(totalBudget - newTarget) > 0.0001) {
            return res.status(422).json({
              error: `Cannot update target amount to ${newTarget}: existing budget breakdown total is ${totalBudget}. Clear the budget breakdown first.`,
            });
          }

          updates.target_amount = newTarget;
          updateParams.push(['target_amount', newTarget, `$${paramIndex++}`]);
        } else if (field === 'deadline') {
          updates.deadline = value === '' ? null : value;
          updateParams.push(['deadline', updates.deadline, `$${paramIndex++}`]);
        } else if (field === 'country') {
          const normalizedCountry =
            typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
          updates.country = normalizedCountry;
          updateParams.push(['country', normalizedCountry, `$${paramIndex++}`]);
        } else if (['min_contribution', 'max_contribution', 'max_per_user'].includes(field)) {
          updates[field] = value === '' ? null : Number(value);
          updateParams.push([field, updates[field], `$${paramIndex++}`]);
        }
      }

      // Check for invalid fields in request body
      for (const field of Object.keys(req.body)) {
        if (!allowedFields.includes(field)) {
          return res.status(422).json({
            error: `Cannot update field: ${field}`,
          });
        }
      }

      // Check if any valid updates were provided
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const effectiveMin =
        updates.min_contribution !== undefined
          ? updates.min_contribution
          : campaign.min_contribution !== null && campaign.min_contribution !== undefined
            ? Number(campaign.min_contribution)
            : null;
      const effectiveMaxPerUser =
        updates.max_per_user !== undefined
          ? updates.max_per_user
          : campaign.max_per_user !== null && campaign.max_per_user !== undefined
            ? Number(campaign.max_per_user)
            : null;
      if (
        effectiveMin !== null &&
        effectiveMaxPerUser !== null &&
        !isNaN(effectiveMin) &&
        !isNaN(effectiveMaxPerUser) &&
        effectiveMaxPerUser <= effectiveMin
      ) {
        return res.status(422).json({
          error: 'Per-contributor cap must be greater than minimum contribution',
        });
      }

      // Build and execute update query
      const setClause = updateParams
        .map(([field, , placeholder]) => `${field} = ${placeholder}`)
        .join(', ');
      const values = updateParams.map(([, value]) => value);
      values.push(campaignId);
      values.push(currentStatus);
      const statusParamIndex = paramIndex + 1;

      const query = `
    UPDATE campaigns
    SET ${setClause}
    WHERE id = $${paramIndex} AND status = $${statusParamIndex}
    RETURNING ${publicCampaignColumnList('')}
  `;

      const updatedRows = await withTransaction(async client => {
        // Save previous state to revisions
        await client.query(
          `INSERT INTO campaign_revisions (campaign_id, title, description, target_amount)
       VALUES ($1, $2, $3, $4)`,
          [campaign.id, campaign.title, campaign.description, campaign.target_amount]
        );

        const result = await client.query(query, values);
        return result.rows;
      }, db);

      if (!updatedRows.length) {
        const { rows: checkRows } = await db.query('SELECT status FROM campaigns WHERE id = $1', [
          campaignId,
        ]);
        if (!checkRows.length) {
          return res.status(404).json({ error: 'Campaign not found' });
        }
        return res.status(422).json({
          error: `Cannot edit a campaign with status: ${checkRows[0].status}`,
        });
      }

      // Invalidate cached campaign payloads so any downstream consumer (e.g. the
      // contribution receipt email path or embed widgets) never serves a stale
      // campaign title after a rename (#733).
      cache.invalidate(`campaigns:id:${campaignId}`);
      cache.invalidatePrefix('campaigns:list:');
      invalidateCampaignFacets();

      // Enumerate the public columns instead of returning the raw row so editing
      // a campaign can never hand the creator the fraud/duplicate internals.
      res.json(stripInternalCampaignFields(updatedRows[0]));
    })
  );

  router.post(
    '/:id/cover-image',
    requireAuth,
    requireCampaignMember('owner', 'editor'),
    (req, res, next) => {
      upload.single('cover_image')(req, res, err => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE' || err.status === 413) {
            return res.status(413).json({
              error: {
                code: 'LIMIT_FILE_SIZE',
                message: 'File exceeds maximum allowed size of 5MB',
                fields: { cover_image: 'File exceeds maximum allowed size of 5MB' },
              },
            });
          }
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
        cache.invalidate(`campaigns:id:${req.params.id}`);
        cache.invalidatePrefix('campaigns:list:');
        res.json(stripInternalCampaignFields(updatedRows[0]));
      } catch (err) {
        if (err.status === 413 || err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: {
              code: 'LIMIT_FILE_SIZE',
              message: 'File exceeds maximum allowed size of 5MB',
              fields: { cover_image: 'File exceeds maximum allowed size of 5MB' },
            },
          });
        }
        if (err.status === 415) {
          return res.status(415).json({
            error: {
              code: 'UNSUPPORTED_MEDIA_TYPE',
              message: err.message || 'Unsupported Media Type',
              fields: { cover_image: err.message || 'Unsupported Media Type' },
            },
          });
        }
        return res.status(500).json({ error: 'Could not upload campaign cover image' });
      }
    }
  );

  router.patch(
    '/:id/visibility',
    requireAuth,
    asyncHandler(async (req, res) => {
      const campaignId = req.params.id;

      const { rows: campaignRows } = await db.query(
        `SELECT ${publicCampaignColumnList('')} FROM campaigns WHERE id = $1`,
        [campaignId]
      );
      if (!campaignRows.length) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const campaign = campaignRows[0];
      const userRole = await resolveUserCampaignRole(
        campaignId,
        req.user.userId,
        req.user.role === 'admin'
      );

      if (userRole !== 'owner') {
        return res.status(403).json({ error: 'Only the campaign owner can change visibility' });
      }

      const newHidden = req.body.is_hidden;
      if (typeof newHidden !== 'boolean') {
        return res.status(422).json({ error: 'is_hidden must be a boolean' });
      }

      const { rows: updatedRows } = await db.query(
        'UPDATE campaigns SET is_hidden = $1 WHERE id = $2 RETURNING *',
        [newHidden, campaignId]
      );

      // Log structured audit trail
      await recordModerationAction({
        req,
        action: newHidden ? 'campaign.hidden' : 'campaign.unhidden',
        actionType: newHidden ? 'campaign_hidden' : 'campaign_unhidden',
        targetType: 'campaign',
        targetId: campaignId,
        reason: req.body?.reason || null,
        before: { is_hidden: campaign.is_hidden, title: campaign.title },
        after: { is_hidden: newHidden },
        metadata: {
          campaign_title: campaign.title,
          previous_is_hidden: campaign.is_hidden,
          new_is_hidden: newHidden,
          reason: req.body?.reason || null,
        },
      });

      cache.invalidate(`campaigns:id:${campaignId}`);
      cache.invalidatePrefix('campaigns:list:');
      invalidateCampaignFacets();

      res.json({ is_hidden: updatedRows[0].is_hidden });
    })
  );

  // GET /campaigns/:id/analytics - full contribution analytics

  return router;
}

module.exports = createCrudRouter;
module.exports.createCrudRouter = createCrudRouter;
