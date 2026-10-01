const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { TransactionBuilder, Keypair } = require('@stellar/stellar-sdk');
const { requireAuth } = require('../middleware/auth');
const {
  contributionValidation,
  contributionQuoteValidation,
  validateRequest,
} = require('../middleware/validation');
const { contributionRateLimiter } = require('../middleware/contributionRateLimiter');
const contributionService = require('../services/contributionService');
const stellarService = require('../services/stellarService');
const sorobanService = require('../services/sorobanService');
const ledgerMonitor = require('../services/ledgerMonitor');
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
const { toStroops, fromStroops } = require('../utils/stroops');
const { networkPassphrase, isTestnet } = require('../config/stellar');
const db = require('../config/database');
const logger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');

const CONTRIBUTION_PREPARE_TOKEN_TTL = '15m';
const RESERVATION_TTL_MINUTES = 15;
const MAX_SEND_SLIPPAGE = 1.05;

const CONTRACT_MODE_CROSS_ASSET_MESSAGE = assetType =>
  `Cross-asset contributions aren't supported for this campaign's contract-backed treasury yet — please contribute in ${assetType} directly.`;

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

function sendMappedError(res, err) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }
  return res.status(503).json({
    error: 'Contribution setup failed — please retry shortly',
  });
}

function formatAmountForMessage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : String(n);
}

function maxSendFromSource(sourceAmount) {
  return (parseFloat(sourceAmount) * MAX_SEND_SLIPPAGE).toFixed(7);
}

function estimatedRate(sourceAmount, destAmount) {
  const source = parseFloat(sourceAmount);
  const dest = parseFloat(destAmount);
  if (!source || !dest) return null;
  return (dest / source).toFixed(15);
}

function verifyPrepareToken(token, expectedAction) {
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    const err = new Error('Invalid or expired prepare token');
    err.statusCode = 422;
    throw err;
  }
  if (decoded.action !== expectedAction) {
    const err = new Error('Prepare token does not match this action');
    err.statusCode = 422;
    throw err;
  }
  return decoded;
}

function parseSignedContributionXdr(signedXdr, unsignedXdr, expectedSender) {
  if (!signedXdr) {
    const err = new Error('signed_xdr is required');
    err.statusCode = 400;
    throw err;
  }
  if (!unsignedXdr) {
    const err = new Error('Server-generated unsigned_xdr is required to verify this contribution');
    err.statusCode = 422;
    throw err;
  }

  let signedTx;
  try {
    signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    const err = new Error('Invalid signed_xdr');
    err.statusCode = 422;
    throw err;
  }

  let unsignedTx;
  try {
    unsignedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  } catch {
    const err = new Error('Invalid server-generated unsigned_xdr');
    err.statusCode = 422;
    throw err;
  }

  if (signedTx.hash().toString('hex') !== unsignedTx.hash().toString('hex')) {
    const err = new Error(
      'Signed transaction does not match the prepared contribution transaction'
    );
    err.statusCode = 422;
    throw err;
  }

  if (expectedSender && signedTx.source !== expectedSender) {
    const err = new Error('Transaction source does not match the prepared sender');
    err.statusCode = 422;
    throw err;
  }

  if (!signedTx.signatures || signedTx.signatures.length === 0) {
    const err = new Error('Signed transaction does not include any signatures');
    err.statusCode = 422;
    throw err;
  }

  if (expectedSender) {
    let signer;
    try {
      signer = Keypair.fromPublicKey(expectedSender);
    } catch {
      const err = new Error('Invalid expected source public key');
      err.statusCode = 422;
      throw err;
    }
    const signatureValid = signedTx.signatures.some(decorated => {
      try {
        return signer.verify(signedTx.hash(), decorated.signature());
      } catch {
        return false;
      }
    });
    if (!signatureValid) {
      const err = new Error(
        'Signed transaction does not include a valid signature from the contributor'
      );
      err.statusCode = 422;
      throw err;
    }
  }

  return signedTx;
}

function assertCampaignGates(campaign) {
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (campaign.migration_in_progress) {
    const err = new Error(
      'Campaign migration is in progress — contributions are temporarily unavailable'
    );
    err.statusCode = 503;
    err.code = 'CAMPAIGN_MIGRATION_IN_PROGRESS';
    throw err;
  }
  if (campaign.status === 'disputed') {
    const err = new Error('Campaign is disputed and cannot accept contributions');
    err.statusCode = 409;
    err.code = 'CAMPAIGN_DISPUTED';
    throw err;
  }
  if (campaign.status !== 'active') {
    const err = new Error('Campaign is not active');
    err.statusCode = 400;
    throw err;
  }
}

function assertContributionAmountBounds(campaign, amount) {
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    const err = new Error('Contribution amount must be greater than zero');
    err.statusCode = 422;
    throw err;
  }
  if (campaign.deadline && new Date(campaign.deadline) < new Date()) {
    const err = new Error('Campaign deadline has passed');
    err.statusCode = 400;
    throw err;
  }
  if (campaign.min_contribution && amountNum < parseFloat(campaign.min_contribution)) {
    const err = new Error(
      `Minimum contribution is ${campaign.min_contribution} ${campaign.asset_type}`
    );
    err.statusCode = 400;
    throw err;
  }
  if (campaign.max_contribution && amountNum > parseFloat(campaign.max_contribution)) {
    const err = new Error(
      `Maximum contribution is ${campaign.max_contribution} ${campaign.asset_type}`
    );
    err.statusCode = 400;
    throw err;
  }
}

async function loadCampaignForContribution(campaignId) {
  const { rows } = await db.query(
    `SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status, deadline,
            min_contribution, max_contribution, max_per_user, migration_in_progress
     FROM campaigns
     WHERE id = $1`,
    [campaignId]
  );
  return rows[0] || null;
}

async function advisoryLockKey(campaignId, senderPublicKey) {
  return `${campaignId}:${senderPublicKey}`;
}

async function readContributionTotals(client, campaignId, senderPublicKey) {
  const { rows: contribRows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = $2 AND refunded = FALSE`,
    [campaignId, senderPublicKey]
  );
  const { rows: reservedRows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM stellar_transactions
     WHERE campaign_id = $1 AND sender_public_key = $2 AND kind = 'contribution'
       AND status = 'reserved' AND (expires_at IS NULL OR expires_at > NOW())`,
    [campaignId, senderPublicKey]
  );
  return {
    contributedTotal: parseFloat(contribRows[0]?.total) || 0,
    reservedTotal: parseFloat(reservedRows[0]?.total) || 0,
  };
}

function assertPerUserCap(campaign, amount, totals, messageStyle) {
  if (!campaign.max_per_user) return;
  const amountNum = parseFloat(amount);
  const already = totals.contributedTotal + totals.reservedTotal;
  if (already + amountNum <= parseFloat(campaign.max_per_user)) return;
  const err = new Error(
    messageStyle === 'prepare'
      ? `Contribution exceeds the per-contributor limit of ${campaign.max_per_user}`
      : `You have already contributed ${formatAmountForMessage(already)} ${campaign.asset_type}. The per-contributor limit is ${campaign.max_per_user}.`
  );
  err.statusCode = 400;
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

async function buildClassicUnsignedXdr({ campaign, amount, sendAsset, senderPublicKey, referralCode }) {
  const memo = contributionService.buildAttributionMemo
    ? contributionService.buildAttributionMemo(campaign.id, referralCode)
    : contributionService.buildContributionMemo(campaign.id);

  if (sendAsset === campaign.asset_type) {
    return {
      unsignedXdr: await stellarService.buildUnsignedContributionPayment({
        senderPublicKey,
        destinationPublicKey: campaign.wallet_public_key,
        asset: sendAsset,
        amount,
        memo,
      }),
      conversionQuote: null,
    };
  }

  const paths = await stellarService.getPathPaymentQuote({
    sendAsset,
    destAsset: campaign.asset_type,
    destAmount: amount,
  });
  if (!paths.length) {
    const err = new Error(`No conversion path found for ${sendAsset} -> ${campaign.asset_type}`);
    err.statusCode = 422;
    throw err;
  }
  const bestPath = paths[0];
  const sendMax = maxSendFromSource(bestPath.source_amount);
  const conversionQuote = {
    send_asset: sendAsset,
    campaign_asset: campaign.asset_type,
    campaign_amount: String(amount),
    quoted_source_amount: bestPath.source_amount,
    max_send_amount: sendMax,
    path: bestPath.path,
    estimated_rate: estimatedRate(bestPath.source_amount, bestPath.destination_amount || amount),
  };
  return {
    unsignedXdr: await stellarService.buildUnsignedContributionPathPayment({
      senderPublicKey,
      destinationPublicKey: campaign.wallet_public_key,
      sendAsset,
      sendMax,
      destAmount: amount,
      destAssetCode: campaign.asset_type,
      memo,
    }),
    conversionQuote,
  };
}

/**
 * GET /api/contributions/quote
 * Public DEX quote for a conversion contribution (#786).
 */
router.get(
  '/quote',
  contributionQuoteValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { send_asset, dest_asset, dest_amount } = req.query;
    if (!send_asset || !dest_asset || dest_amount === undefined || dest_amount === '') {
      return res.status(400).json({ error: 'send_asset, dest_asset and dest_amount are required' });
    }

    const supported = stellarService.getSupportedAssetCodes
      ? stellarService.getSupportedAssetCodes()
      : ['XLM', 'USDC'];
    if (!supported.includes(send_asset) || !supported.includes(dest_asset)) {
      return res.status(400).json({ error: 'Unsupported asset for conversion quote' });
    }

    let amountStroops;
    try {
      amountStroops = toStroops(dest_amount);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
    const destAmount = fromStroops(amountStroops);

    const paths = await stellarService.getPathPaymentQuote({
      sendAsset: send_asset,
      destAsset: dest_asset,
      destAmount,
    });

    if (!paths.length) {
      return res.status(404).json({
        error: `No conversion path found for ${send_asset} -> ${dest_asset}`,
        code: 'NO_CONVERSION_PATH',
      });
    }

    const bestPath = paths[0];
    return res.status(200).json({
      send_asset,
      dest_asset,
      dest_amount: destAmount,
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: maxSendFromSource(bestPath.source_amount),
      estimated_rate: estimatedRate(bestPath.source_amount, bestPath.destination_amount || destAmount),
      path: bestPath.path || [],
      path_count: paths.length,
    });
  })
);

/**
 * POST /api/contributions
 * Custodial contribution flow (#786 hardening).
 */
router.post(
  '/',
  requireAuth,
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
    } = req.body;
    const userId = req.user.userId;

    await assertUserKycVerified(userId);

    const campaign = await loadCampaignForContribution(campaign_id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.migration_in_progress) {
      return res.status(503).json({
        error: 'Campaign migration is in progress — contributions are temporarily unavailable',
        code: 'CAMPAIGN_MIGRATION_IN_PROGRESS',
      });
    }
    if (campaign.status === 'disputed') {
      return res.status(409).json({
        error: 'Campaign is disputed and cannot accept contributions',
        code: 'CAMPAIGN_DISPUTED',
      });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }

    const sendAsset = send_asset || campaign.asset_type;

    try {
      assertContributionAmountBounds(campaign, amount);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const { walletPublicKey, walletSecretEncrypted } = await resolveContributorWallet(req);

    try {
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
    // once, inside the contribution transaction below (#900).
    let previewPath = null;

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');

      if (campaign.max_per_user) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          await advisoryLockKey(campaign_id, walletPublicKey),
        ]);
        const totals = await readContributionTotals(client, campaign_id, walletPublicKey);
        assertPerUserCap(campaign, amount, totals, 'custodial');
      }

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
        idempotencyKey: idempotency_key,
        client,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (
        err.code === 'CONTRIBUTOR_REQUIREMENTS_NOT_MET' ||
        err.code === 'IDENTITY_UNAVAILABLE' ||
        err.code === 'ATTESTATION_UNAVAILABLE'
      ) {
        return mapContributionGateError(err, res);
      }
      if (err.statusCode) {
        return res.status(err.statusCode).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        });
      }
      // Trustline / custodial wallet setup failures are transient (#786).
      return res.status(503).json({
        error: 'Custodial wallet setup failed — please retry shortly',
      });
    } finally {
      client.release();
    }

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      stellar_transaction_id: result.stellarTransactionId,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
      platform_fee_amount: result.platformFeeAmount ?? result.platform_fee_amount ?? 0,
      preview_validated: Boolean(previewPath),
      diagnosis: result.flowMetadata?.diagnosis || contributionDiagnostics.STATUS_PENDING,
    });
  })
);

/**
 * POST /api/contributions/prepare
 * Freighter prepare flow: unsigned XDR + short-lived prepare token (#786).
 */
router.post(
  '/prepare',
  requireAuth,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, send_asset, sender_public_key } = req.body;

    if (!campaign_id || amount === undefined || amount === null || !send_asset || !sender_public_key) {
      return res.status(400).json({
        error: 'campaign_id, amount, send_asset and sender_public_key are required',
      });
    }

    try {
      Keypair.fromPublicKey(sender_public_key);
    } catch {
      return res.status(400).json({ error: 'sender_public_key must be a valid Stellar public key' });
    }

    let amountStroops;
    try {
      amountStroops = toStroops(amount);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
    const normalizedAmount = fromStroops(amountStroops);

    const campaign = await loadCampaignForContribution(campaign_id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.migration_in_progress) {
      return res.status(503).json({
        error: 'Campaign migration is in progress — contributions are temporarily unavailable',
        code: 'CAMPAIGN_MIGRATION_IN_PROGRESS',
      });
    }
    if (campaign.status === 'disputed') {
      return res.status(409).json({
        error: 'Campaign is disputed and cannot accept contributions',
        code: 'CAMPAIGN_DISPUTED',
      });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }

    try {
      assertContributionAmountBounds(campaign, normalizedAmount);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const contractMode = sorobanService.isContractDepositEligible(campaign);
    if (contractMode && send_asset !== campaign.asset_type) {
      return res.status(422).json({
        error: CONTRACT_MODE_CROSS_ASSET_MESSAGE(campaign.asset_type),
      });
    }

    const client = await db.connect();
    let unsignedXdr;
    let conversionQuote = null;
    let reservationId = null;

    try {
      await client.query('BEGIN');

      if (campaign.max_per_user) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          await advisoryLockKey(campaign_id, sender_public_key),
        ]);
        const totals = await readContributionTotals(client, campaign_id, sender_public_key);
        assertPerUserCap(campaign, normalizedAmount, totals, 'prepare');
      }

      if (contractMode) {
        unsignedXdr = await sorobanService.buildUnsignedEscrowDeposit({
          contractId: campaign.escrow_contract_id,
          fromAddress: sender_public_key,
          amount: Number(amountStroops),
        });
      } else {
        const built = await buildClassicUnsignedXdr({
          campaign,
          amount: normalizedAmount,
          sendAsset: send_asset,
          senderPublicKey: sender_public_key,
        });
        unsignedXdr = built.unsignedXdr;
        conversionQuote = built.conversionQuote;
      }

      const { rows: insertRows } = await client.query(
        `INSERT INTO stellar_transactions
           (kind, status, campaign_id, sender_public_key, unsigned_xdr, amount, expires_at, metadata)
         VALUES ('contribution', 'reserved', $1, $2, $3, $4, NOW() + INTERVAL '${RESERVATION_TTL_MINUTES} minutes', $5::jsonb)
         RETURNING id`,
        [
          campaign_id,
          sender_public_key,
          unsignedXdr,
          normalizedAmount,
          JSON.stringify({ conversion_quote: conversionQuote }),
        ]
      );
      reservationId = insertRows[0]?.id;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return sendMappedError(res, err);
    } finally {
      client.release();
    }

    const prepareToken = jwt.sign(
      {
        action: 'contribution',
        campaignId: campaign_id,
        sender: sender_public_key,
        amount: normalizedAmount,
        sendAsset: send_asset,
        conversionQuote,
        unsignedXdr,
        reservationId,
      },
      process.env.JWT_SECRET,
      { expiresIn: CONTRIBUTION_PREPARE_TOKEN_TTL }
    );

    return res.status(200).json({
      prepare_token: prepareToken,
      unsigned_xdr: unsignedXdr,
      sender_public_key,
      network_name: isTestnet ? 'TESTNET' : 'PUBLIC',
      network_passphrase: networkPassphrase,
      conversion_quote: conversionQuote,
    });
  })
);

/**
 * POST /api/contributions/submit-signed
 * Finalizes a Freighter-signed contribution after hash/signature checks (#786).
 */
router.post(
  '/submit-signed',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { prepare_token, signed_xdr } = req.body;
    if (!prepare_token || !signed_xdr) {
      return res.status(400).json({ error: 'prepare_token and signed_xdr are required' });
    }

    let decoded;
    try {
      decoded = verifyPrepareToken(prepare_token, 'contribution');
    } catch (err) {
      return res.status(err.statusCode || 422).json({ error: err.message });
    }

    try {
      parseSignedContributionXdr(signed_xdr, decoded.unsignedXdr, decoded.sender);
    } catch (err) {
      return res.status(err.statusCode || 422).json({ error: err.message });
    }

    const { rows: reservationRows } = await db.query(
      'SELECT id, status, amount, expires_at FROM stellar_transactions WHERE id = $1',
      [decoded.reservationId]
    );
    const reservation = reservationRows[0];
    const reservationExpired =
      reservation?.expires_at && new Date(reservation.expires_at).getTime() < Date.now();
    if (!reservation || reservation.status !== 'reserved' || reservationExpired) {
      return res.status(410).json({
        error: 'Contribution reservation is no longer available',
        code: 'RESERVATION_EXPIRED',
      });
    }

    const { rows: campaignRows } = await db.query(
      `SELECT id, status, asset_type, wallet_public_key, escrow_contract_id, migration_in_progress
       FROM campaigns WHERE id = $1`,
      [decoded.campaignId]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    let txHash;
    try {
      txHash = await stellarService.submitPreparedTransaction(signed_xdr);
    } catch (err) {
      logger.error('Failed to submit Freighter contribution transaction', {
        error: err.message,
        campaignId: decoded.campaignId,
      });
      return res.status(err.statusCode || 502).json({
        error: err.message || 'Stellar rejected the signed contribution transaction',
      });
    }

    const { rows: updateRows } = await db.query(
      `UPDATE stellar_transactions
       SET status = 'submitted', tx_hash = $1, unsigned_xdr = $2, signed_xdr = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id`,
      [txHash, decoded.unsignedXdr, signed_xdr, reservation.id]
    );
    const stellarTransactionId = updateRows[0]?.id || reservation.id;

    const contractMode = Boolean(campaign.escrow_contract_id);
    if (contractMode) {
      await ledgerMonitor.recordConfirmedContribution({
        campaignId: decoded.campaignId,
        senderPublicKey: decoded.sender,
        destinationAsset: campaign.asset_type,
        destinationAmount: decoded.amount,
        paymentType: 'payment',
        txHash,
        walletMode: 'freighter',
      });
    } else {
      await db.query(
        `INSERT INTO contributions
           (campaign_id, sender_public_key, amount, asset, payment_type, tx_hash, platform_fee_amount)
         VALUES ($1, $2, $3, $4, 'payment', $5, $6)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [
          decoded.campaignId,
          decoded.sender,
          decoded.amount,
          campaign.asset_type,
          txHash,
          decoded.conversionQuote?.platform_fee_amount ?? null,
        ]
      );
    }

    return res.status(202).json({
      tx_hash: txHash,
      stellar_transaction_id: stellarTransactionId,
      conversion_quote: decoded.conversionQuote || null,
      message: 'Transaction submitted',
    });
  })
);

/**
 * POST /api/contributions/:id/refund
 * Refund a contribution from a failed campaign (#786).
 */
router.post(
  '/:id/refund',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT c.id, c.campaign_id, c.sender_public_key, c.amount, c.asset, c.tx_hash,
              c.refunded, c.refund_status, c.contract_refunded_at, c.contract_refund_tx_hash,
              campaigns.status AS campaign_status, campaigns.escrow_contract_id, campaigns.creator_id
       FROM contributions c
       JOIN campaigns ON campaigns.id = c.campaign_id
       WHERE c.id = $1`,
      [id]
    );
    const contribution = rows[0];
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    const eligibility = {
      eligible: false,
      campaign_status: contribution.campaign_status,
      contract_refunded_at: contribution.contract_refunded_at,
      contract_refund_tx_hash: contribution.contract_refund_tx_hash,
      refunded: Boolean(contribution.refunded),
    };

    if (contribution.contract_refunded_at || contribution.contract_refund_tx_hash) {
      return res.status(409).json({
        error: 'This contribution has already been refunded',
        code: 'ALREADY_REFUNDED',
        tx_hash: contribution.contract_refund_tx_hash || contribution.tx_hash,
        eligibility: { ...eligibility, eligible: false, reason: 'already_refunded' },
      });
    }

    if (contribution.campaign_status !== 'failed') {
      return res.status(400).json({
        error: 'Refunds are only available for failed campaigns',
        campaign_status: contribution.campaign_status,
        eligibility: { ...eligibility, eligible: false, reason: 'campaign_not_failed' },
      });
    }

    let refundResult;
    try {
      refundResult = await sorobanService.triggerRefund({
        escrowContractId: contribution.escrow_contract_id,
        contributorAddress: contribution.sender_public_key,
        signerSecret: process.env.PLATFORM_SECRET_KEY,
      });
    } catch (err) {
      logger.error('Failed to trigger contribution refund', {
        error: err.message,
        contributionId: id,
      });
      return res.status(err.statusCode || 502).json({
        error: err.message || 'Failed to trigger on-chain refund',
        campaign_status: contribution.campaign_status,
        eligibility: { ...eligibility, eligible: true, reason: 'refund_trigger_failed' },
      });
    }

    const refundTxHash =
      typeof refundResult === 'string'
        ? refundResult
        : refundResult?.txHash || refundResult?.hash || contribution.tx_hash;

    await db.query(
      `UPDATE contributions
       SET refunded = TRUE, refund_status = 'full', contract_refunded_at = NOW(), contract_refund_tx_hash = $1
       WHERE id = $2`,
      [refundTxHash, id]
    );

    return res.status(200).json({
      tx_hash: refundTxHash,
      contribution_id: id,
    });
  })
);

/**
 * GET /api/contributions/finalization/:txHash
 * Look up finalization status for a submitted contribution transaction (#786).
 */
router.get(
  '/finalization/:txHash',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { txHash } = req.params;

    const { rows } = await db.query(
      `SELECT st.id, st.status, st.tx_hash, st.campaign_id, st.contribution_id,
              st.initiated_by_user_id, st.metadata, st.created_at, st.updated_at,
              c.id AS contribution_row_id, c.sender_public_key, c.amount, c.asset,
              c.created_at AS contribution_created_at,
              campaigns.creator_id
       FROM stellar_transactions st
       LEFT JOIN contributions c ON c.id = st.contribution_id
       LEFT JOIN campaigns ON campaigns.id = st.campaign_id
       WHERE st.tx_hash = $1 AND st.kind = 'contribution'`,
      [txHash]
    );
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Contribution transaction not found' });
    }

    const contributionId = row.contribution_row_id || row.contribution_id;
    return res.status(200).json({
      finalization_status: row.status === 'indexed' ? 'finalized' : row.status,
      stellar_transaction: {
        id: row.id,
        status: row.status,
        tx_hash: row.tx_hash,
        campaign_id: row.campaign_id,
        contribution_id: row.contribution_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      contribution: contributionId
        ? {
            id: contributionId,
            campaign_id: row.campaign_id,
            sender_public_key: row.sender_public_key,
            amount: row.amount,
            asset: row.asset,
            tx_hash: row.tx_hash,
            created_at: row.contribution_created_at,
          }
        : null,
    });
  })
);

/**
 * GET /api/contributions/campaign/:campaignId
 * Public paginated contribution list for a campaign (#786 / #490).
 */
router.get(
  '/campaign/:campaignId',
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const { limit, offset } = parsePagination(req.query);

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

    return res.json({ contributions, total, limit, offset });
  })
);

router.post(
  '/embed',
  contributionRateLimiter,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, send_asset, embed_token } = req.body;
    if (!embed_token) {
      return res.status(401).json({ error: 'Embed token required' });
    }
    /*
     * Distinguish JWT-only format/expiry verification (embedTokenJwtService)
     * from DB-backed revocation/existence checks (embedTokenService).
     * First verify token format and signature/expiry via JWT service.
     */
    const jwtPayload = verifyEmbedToken(embed_token);
    if (!jwtPayload) {
      return res.status(401).json({ error: 'Invalid or expired embed token' });
    }
    if (jwtPayload.sub !== campaign_id) {
      return res.status(403).json({ error: 'Embed token does not match this campaign' });
    }
    /*
     * Now perform DB-backed revocation and existence validation via embedTokenService.
     */
    const tokenPayload = await embedTokenService.validateEmbedToken(embed_token);
    if (!tokenPayload) {
      return res.status(401).json({ error: 'Embed token has been revoked or is invalid' });
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

    const result = await contributionService.submitCustodialContribution({
      campaign,
      campaignId: campaign_id,
      userId,
      walletPublicKey: user.wallet_public_key,
      walletSecretEncrypted: user.wallet_secret_encrypted,
      amount,
      sendAsset: send_asset || campaign.asset_type,
    });

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
      platform_fee_amount: result.platformFeeAmount ?? result.platform_fee_amount ?? 0,
    });
  })
);

function isContributionViewer(req, contribution, campaignCreatorId) {
  if (req.user?.role === 'admin') return true;
  if (campaignCreatorId === req.user?.userId) return true;
  if (req.user?.walletPublicKey && contribution.sender_public_key === req.user.walletPublicKey) {
    return true;
  }
  return false;
}

router.get(
  '/:id/diagnosis',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT c.id, c.campaign_id, c.sender_public_key, c.payment_type, c.path_hops,
              c.effective_rate, c.slippage_bps, c.send_max, c.retry_count, c.diagnosis, c.tx_hash,
              st.metadata AS metadata
       FROM contributions c
       LEFT JOIN stellar_transactions st ON st.tx_hash = c.tx_hash AND st.kind = 'contribution'
       WHERE c.id = $1`,
      [id]
    );
    const contribution = rows[0];
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [contribution.campaign_id]
    );
    if (!isContributionViewer(req, contribution, campaignRows[0]?.creator_id)) {
      return res.status(403).json({ error: 'Not authorized to view this contribution' });
    }

    const metadata = contribution.metadata || {};
    const report = await contributionDiagnostics.diagnoseContribution({
      contribution,
      metadata,
      txHash: contribution.tx_hash,
    });

    if (report.status && report.status !== contribution.diagnosis) {
      await db.query('UPDATE contributions SET diagnosis = $1 WHERE id = $2', [
        report.status,
        contribution.id,
      ]);
    }

    return res.json({ diagnosis: report });
  })
);

module.exports = router;
