const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { contributionValidation, validateRequest } = require('../middleware/validation');
const { contributionRateLimiter } = require('../middleware/contributionRateLimiter');
const { idempotency } = require('../middleware/idempotency');
const contributionService = require('../services/contributionService');
const stellarService = require('../services/stellarService');
const embedTokenService = require('../services/embedTokenService');
const { verifyEmbedToken } = require('../services/embedTokenJwtService');
const pathPaymentPreviewService = require('../services/pathPaymentPreview');
const contributionDiagnostics = require('../services/contributionDiagnostics');
const { resolveReferralLink } = require('../services/referral');
const { getReferralCodeFromRequest } = require('../services/referralService');
const {
  reserveTierSlot,
  reserveInventory,
  claimInventory,
  releaseInventory,
  createFulfillment,
} = require('../services/rewardTierService');
const { assertUserKycVerified } = require('../services/kycService');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { assertContributorMeetsRequirements } = require('../services/contributorIdentityService');
const { assertContributionPolicy } = require('../services/contributionPolicy');
const campaignRiskDisclosureService = require('../services/campaignRiskDisclosureService');
const db = require('../config/database');
const logger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');

function mapContributionGateError(err, res) {
  if (err.statusCode === 403 && err.code === 'CONTRIBUTOR_REQUIREMENTS_NOT_MET') {
    return res.status(403).json({
      error: err.message,
      code: err.code,
      missing: err.missing || [],
    });
  }
  if (
    err.statusCode === 503 &&
    (err.code === 'IDENTITY_UNAVAILABLE' || err.code === 'ATTESTATION_UNAVAILABLE')
  ) {
    return res.status(503).json({ error: err.message, code: err.code });
  }
  throw err;
}

async function resolveContributorWallet(req) {
  if (req.user?.walletPublicKey && req.user?.walletSecretEncrypted) {
    return {
      walletPublicKey: req.user.walletPublicKey,
      walletSecretEncrypted: req.user.walletSecretEncrypted,
    };
  }

  const { rows } = await db.query(
    'SELECT wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!rows.length || !rows[0].wallet_public_key) {
    const err = new Error('User does not have a custodial wallet configured');
    err.statusCode = 400;
    throw err;
  }
  return {
    walletPublicKey: rows[0].wallet_public_key,
    walletSecretEncrypted: rows[0].wallet_secret_encrypted,
  };
}

async function assertRiskDisclosureAcknowledged({
  campaignId,
  userId,
  acknowledged,
  disclosureVersion,
  client = db,
}) {
  const required = await campaignRiskDisclosureService.getActiveDisclosure(campaignId, client);
  if (!required) {
    return null;
  }

  if (acknowledged !== true) {
    const err = new Error('Campaign risk disclosure must be acknowledged before contributing');
    err.statusCode = 428;
    err.code = 'RISK_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED';
    err.disclosure = campaignRiskDisclosureService.serializeDisclosure(required);
    throw err;
  }

  if (
    disclosureVersion != null &&
    String(disclosureVersion) !== String(required.version)
  ) {
    const err = new Error('Risk disclosure version is outdated; reload the campaign and review the current disclosure');
    err.statusCode = 409;
    err.code = 'RISK_DISCLOSURE_VERSION_MISMATCH';
    err.disclosure = campaignRiskDisclosureService.serializeDisclosure(required);
    throw err;
  }

  return campaignRiskDisclosureService.recordAcknowledgement({
    campaignId,
    userId,
    disclosureId: required.id,
    disclosureVersion: required.version,
    client,
  });
}

router.get(
  '/risk-disclosure/:campaignId',
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const { rows: campaignRows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (!campaignRows[0]) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const disclosure = await campaignRiskDisclosureService.getActiveDisclosure(
      campaignId,
      db
    );
    return res.json({
      campaign_id: campaignId,
      disclosure: disclosure
        ? campaignRiskDisclosureService.serializeDisclosure(disclosure)
        : null,
      acknowledgement_required: Boolean(disclosure),
    });
  })
);

router.post(
  '/',
  requireAuth,
  idempotency('contribution:create', { bodyField: 'idempotency_key' }),
  contributionRateLimiter,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const {
      campaign_id,
      amount,
      send_asset,
      tier_id,
      display_name,
      preview_token,
      selected_path_index,
      idempotency_key,
      gift,
      risk_disclosure_acknowledged,
      risk_disclosure_version,
    } = req.body;
    const userId = req.user.userId;

    await assertUserKycVerified(userId);

    const { rows: campaignRows } = await db.query(
      'SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status, deadline, min_contribution, max_contribution, max_per_user FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }
    const sendAsset = send_asset || campaign.asset_type;

    const { walletPublicKey, walletSecretEncrypted } = await resolveContributorWallet(req);

    try {
      await assertContributionPolicy(campaign, amount, walletPublicKey);
      await assertContributorMeetsRequirements(walletPublicKey, campaign_id);
    } catch (err) {
      if (
        err.code === 'CONTRIBUTOR_REQUIREMENTS_NOT_MET' ||
        err.code === 'IDENTITY_UNAVAILABLE' ||
        err.code === 'ATTESTATION_UNAVAILABLE'
      ) {
        return mapContributionGateError(err, res);
      }
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const referralCode = getReferralCodeFromRequest(req);
    let referralLink = null;
    if (referralCode) {
      referralLink = await resolveReferralLink({ campaignId: campaign_id, code: referralCode });
    }

    // Cross-asset contributions may arrive with a single-use preview token from
    // POST /api/campaigns/:id/contribution/preview. The token is redeemed exactly
    // once, inside the contribution transaction below (#900): redeeming it here
    // as well destroyed it before the transaction ran, so every quoted
    // cross-asset contribution failed with PREVIEW_EXPIRED and the approved
    // route was never applied.
    let previewPath = null;

    const client = await db.connect();
    let result;
    let riskAcknowledgement;
    try {
      await client.query('BEGIN');

      // Record the contributor's acknowledgement of the campaign risk
      // disclosure in the same transaction as the contribution so the two
      // cannot di verge. This also blocks contributions when a disclosure
      // is required but not acknowledged.
      riskAcknowledgement = await assertRiskDisclosureAcknowledged({
        campaignId: campaign_id,
        userId,
        acknowledged: risk_disclosure_acknowledged,
        disclosureVersion: risk_disclosure_version,
        client,
      });

      if (tier_id) {
        const reserved = await reserveTierSlot(client, {
          tierId: tier_id,
          campaignId: campaign_id,
        });
        if (!reserved) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Reward tier is no longer available' });
        }
        const invOk = await reserveInventory(client, {
          tierId: tier_id,
          contributionId: idempotency_key || campaign_id,
          quantity: 1,
        });
        if (!invOk) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'REWARD_TIER_SOLD_OUT' });
        }
      }

      // Redeem the single-use preview token exactly once, inside the
      // transaction, and thread the approved route into submission so the
      // max_send_amount the contributor agreed to is actually enforced (#900).
      // Callers without a token fall back to quoting the best route inline in
      // buildContributionIntent (#688).
      if (sendAsset !== campaign.asset_type && preview_token) {
        previewPath = await pathPaymentPreviewService.consumeContributionPreview({
          previewToken: preview_token,
          campaignId: campaign_id,
          sendAsset,
          amount,
          selectedPathIndex:
            typeof selected_path_index === 'number'
              ? selected_path_index
              : Number(selected_path_index),
        });
      }

      result = await contributionService.submitCustodialContribution({
        campaign,
        campaignId: campaign_id,
        userId,
        walletPublicKey,
        walletSecretEncrypted,
        amount,
        sendAsset,
        displayName: display_name,
        gift,
        referralCode,
        referralLinkCode: referralLink?.code,
        referralLinkId: referralLink?.id,
        tierId: tier_id,
        previewPath,
        idompotencyKey: req.idempotencyKey || idempotency_key,
        client,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === 'RISK_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED') {
        return res.status(428).json({
          error: err.message,
          code: err.code,
          disclosure: err.disclosure,
        });
      }
      if (err.code === 'RISK_DISCLOSURE_VERSION_MISMATCH') {
        return res.status(409).json({
          error: err.message,
          code: err.code,
          disclosure: err.disclosure,
        });
      }
      throw err;
    } finally {
      client.release();
    }

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
      platform_fee_amount: result.platformFeeAmount ?? result.platform_fee_amount ?? 0,
      preview_validated: Boolean(previewPath),
      diagnosis: result.flowMetadata?.diagnosis || contributionDiagnostics.STATUS_PENDING,
      risk_disclosure_acknowledged: Boolean(riskAcknowledgement),
      risk_disclosure_version: riskAcknowledgment?.disclosure_version || null,
    });
  })
);

router.post(
  '/embed',
  contributionRateLimiter,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, send_asset, embed_token, risk_disclosure_acknowledged, risk_disclosure_version } = req.body;
    if (!embed_token) {
      return res.status(401).json({ error: 'Embed token required' });
    }
    /*
     * Distinguish JWT-only format/expiry verification (embedTokenJwtService)
     * from DB-backed revocation/existence checks (embedTokenService).
     * First verify token format and signature/expiry via JWT service.
     */
    const jwtPayload = verifyEmbedToken(embed_token);
    if (!jwtPayload || typeof jwtPayload.sub !== 'string' || jwtPayload.sub !== String(campaign_id)) {
      return res.status(401).json({ error: 'Invalid or expired embed token' });
    }
    /*
     * Now perform DB-backed revocation and existence validation via embedTokenService.
     */
    const tokenPayload = await embedTokenService.validateEmbedToken(embed_token);
    if (!tokenPayload) {
      return res.status(403).json({ error: 'Embed token has been revoked or is invalid' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status, deadline, min_contribution, max_contribution, max_per_user FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }

    const userId = tokenPayload.user_id;
    const { rows: userRows } = await db.query(
      'SELECT wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
      [userId]
    );
    const user = userRows[0];
    if (!user || !user.wallet_public_key) {
      return res.status(400).json({ error: 'Contributor wallet not found' });
    }

    try {
      await assertContributionPolicy(campaign, amount, user.wallet_public_key);
      await assertUserKycVerified(userId);
      await assertContributorMeetsRequirements(user.wallet_public_key, campaign_id);
    } catch (err) {
      if (
        err.code === 'CONTRIBUTOR_REQUIREMENTS_NOT_MET' ||
        err.code === 'IDENTITY_UNAVAILABLE' ||
        err.code === 'ATTESTATION_UNAVAILABLE'
      ) {
        return mapContributionGateError(err, res);
      }
      if (err.code === 'KYC_REQUIRED' || err.statusCode === 403) {
        return res.status(err.statusCode || 403).json({
          error: err.message,
          code: err.code,
          missing: err.missing || undefined,
        });
      }
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const client = await db.connect();
    let result;
    let riskAcknowledgment;
    try {
      await client.query('BEGIN');
      riskAcknowledgment = await assertRiskDisclosureAcknowledged({
        campaignId: campaign_id,
        userId,
        acknowledged: risk_disclosure_acknowledged,
        disclosureVersion: risk_disclosure_version,
        client,
      });

      result = await contributionService.submitCustodialContribution({
        campaign,
        campaignId: campaign_id,
        userId,
        walletPublicKey: user.wallet_public_key,
        walletSecretEncrypted: user.wallet_secret_encrypted,
        amount,
        sendAsset: send_asset || campaign.asset_type,
        client,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === 'RISK_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED') {
        return res.status(428).json({
          error: err.message,
          code: err.code,
          disclosure: err.disclosure,
        });
      }
      if (err.code === 'RISK_DISCLOSURE_VERSION_MISMATCH') {
        return res.status(409).json({
          error: err.message,
          code: err.code,
          disclosure: err.disclosure,
        });
      }
      throw err;
    } finally {
      client.release();
    }

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
      platform_fee_amount: result.platformFeeAmount ?? result.platform_fee_amount ?? 0,
      risk_disclosure_acknowledged: Boolean(riskAcknowledgement),
      risk_disclosure_version: riskAcknowledgment?.disclosure_version || null,
    });
  })
);

router.get(
  '/campaign/:campaignId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const { limit, offset } = parsePagination(req.query);

    const { rows: campaignRows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (!campaignRows[0]) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { data: contributions, total } = await paginatedResponse(
      db,
      'SELECT COUNT(*)::int AS total FROM contributions WHERE campaign_id = $1',
      `SELECT id, campaign_id, sender_public_key, amount, asset, display_name, payment_type,
              source_amount, source_asset, conversion_rate, path, path_hops, effective_rate,
              slippage_bps, send_max, retry_count, diagnosis, tx_hash, created_at
       FROM contributions
       WHERE campaign_id = $1
       ORDER BY created_at DESC`,
      [campaignId],
      limit,
      offset
    );

    return res.json({ contributions, total });
  })
);

module.exports = router;
