const express = require('express');
const jwt = require('jsonwebtoken');
const { StrKey, TransactionBuilder } = require('@stellar/stellar-sdk');
const router = express.Router();
const { networkPassphrase, isTestnet } = require('../config/stellar');
const sorobanService = require('../services/sorobanService');
const ledgerMonitor = require('../services/ledgerMonitor');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const { toStroops, fromStroops, mulBpsCeil } = require('../utils/stroops');
const { requireAuth } = require('../middleware/auth');
const {
  contributionValidation,
  contributionQuoteValidation,
  validateRequest,
} = require('../middleware/validation');
const { contributionRateLimiter } = require('../middleware/contributionRateLimiter');
const contributionService = require('../services/contributionService');
const stellarService = require('../services/stellarService');
const embedTokenService = require('../services/embedTokenService');
const { verifyEmbedToken } = require('../services/embedTokenJwtService');
const pathPaymentPreviewService = require('../services/pathPaymentPreview');
const contributionDiagnostics = require('../services/contributionDiagnostics');
const { resolveReferralLink } = require('../services/referral');
const { getReferralCodeFromRequest } = require('../services/referralService');
const { reserveTierSlot, reserveInventory, claimInventory, releaseInventory, createFulfillment } = require('../services/rewardTierService');
const { assertUserKycVerified } = require('../services/kycService');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { assertContributorMeetsRequirements } = require('../services/contributorIdentityService');
const { assertContributionPolicy } = require('../services/contributionPolicy');
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

const PREPARE_TOKEN_TTL_S = 15 * 60;
const PREPARE_TOKEN_TYPE = 'contribution_prepare';
const CROSS_ASSET_CONTRACT_MESSAGE = assetType =>
  `Cross-asset contributions aren't supported for this campaign's contract-backed treasury yet — please contribute in ${assetType} directly.`;

function httpError(statusCode, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

/** Deadline, positive amount and min/max bounds (all in the campaign's asset). */
function assertContributionLimits(campaign, amount) {
  const value = parseFloat(amount);
  if (isNaN(value) || value <= 0) {
    throw httpError(422, 'Contribution amount must be greater than zero');
  }
  if (campaign.deadline && new Date(campaign.deadline).getTime() < Date.now()) {
    throw httpError(400, 'Campaign deadline has passed');
  }
  if (campaign.min_contribution && value < parseFloat(campaign.min_contribution)) {
    throw httpError(
      400,
      `Minimum contribution is ${campaign.min_contribution} ${campaign.asset_type}`
    );
  }
  if (campaign.max_contribution && value > parseFloat(campaign.max_contribution)) {
    throw httpError(
      400,
      `Maximum contribution is ${campaign.max_contribution} ${campaign.asset_type}`
    );
  }
}

/**
 * Enforces campaigns.max_per_user inside the caller's open transaction. A
 * transaction-scoped advisory lock on (campaign, sender) serializes concurrent
 * requests so two in-flight contributions cannot both slip under the cap. Counts
 * indexed contributions plus unexpired Freighter /prepare reservations and
 * submitted-but-unindexed transactions. Returns an error message or null.
 */
async function checkPerUserCap(client, campaign, senderPublicKey, amount) {
  if (!campaign.max_per_user || !senderPublicKey) return null;

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${campaign.id}:${senderPublicKey}`,
  ]);
  const { rows: contributed } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = $2 AND refunded = FALSE`,
    [campaign.id, senderPublicKey]
  );
  const { rows: inFlight } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM stellar_transactions
     WHERE campaign_id = $1 AND sender_public_key = $2 AND kind = 'contribution'
       AND ((status = 'reserved' AND (expires_at IS NULL OR expires_at > NOW()))
            OR status = 'submitted')`,
    [campaign.id, senderPublicKey]
  );
  const total = (parseFloat(contributed[0]?.total) || 0) + (parseFloat(inFlight[0]?.total) || 0);
  if (total + parseFloat(amount) > parseFloat(campaign.max_per_user)) {
    return `You have already contributed ${total} ${campaign.asset_type}. The per-contributor limit is ${campaign.max_per_user}.`;
  }
  return null;
}

/** 409/503 gates shared by the custodial and Freighter flows. */
function campaignStateError(campaign) {
  if (campaign.status === 'disputed') {
    return { status: 409, body: { error: 'Campaign is under dispute', code: 'CAMPAIGN_DISPUTED' } };
  }
  if (campaign.migration_in_progress) {
    return {
      status: 503,
      body: {
        error: 'Campaign contract is being migrated — please retry shortly',
        code: 'CAMPAIGN_MIGRATION_IN_PROGRESS',
      },
    };
  }
  if (campaign.status !== 'active') {
    return { status: 400, body: { error: 'Campaign is not active' } };
  }
  return null;
}

const CAMPAIGN_COLUMNS =
  'id, title, asset_type, wallet_public_key, escrow_contract_id, status, deadline, min_contribution, max_contribution, max_per_user, migration_in_progress';

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

    const { rows: campaignRows } = await db.query(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = $1`,
      [campaign_id]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const stateError = campaignStateError(campaign);
    if (stateError) {
      return res.status(stateError.status).json(stateError.body);
    }
    const sendAsset = send_asset || campaign.asset_type;

    const { walletPublicKey, walletSecretEncrypted } = await resolveContributorWallet(req);

    try {
      assertContributionLimits(campaign, amount);
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

    // Make sure the custodial account exists and trusts the asset before
    // opening a transaction, so a transient Horizon failure is retryable.
    try {
      await withDecryptedWalletSecret(
        walletSecretEncrypted,
        { userId, walletPublicKey },
        async senderSecret =>
          stellarService.ensureCustodialAccountFundedAndTrusted({
            publicKey: walletPublicKey,
            secret: senderSecret,
          })
      );
    } catch (err) {
      logger.error('Custodial account setup failed before contribution', {
        user_id: userId,
        error: err.message,
      });
      return res.status(503).json({
        error: 'Unable to prepare your wallet right now. Please retry in a moment.',
      });
    }

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');

      const capError = await checkPerUserCap(client, campaign, walletPublicKey, amount);
      if (capError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: capError });
      }

      if (tier_id) {
        const reserved = await reserveTierSlot(client, { tierId: tier_id, campaignId: campaign_id });
        if (!reserved) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Reward tier is no longer available' }); }
        const invOk = await reserveInventory(client, { tierId: tier_id, contributionId: idempotency_key || campaign_id, quantity: 1 });
        if (!invOk) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'REWARD_TIER_SOLD_OUT' }); }
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
        idempotencyKey: idempotency_key,
        client,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      stellar_transaction_id: result.stellarTransactionId || null,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
      platform_fee_amount: result.platformFeeAmount ?? result.platform_fee_amount ?? 0,
      preview_validated: Boolean(previewPath),
      diagnosis: result.flowMetadata?.diagnosis || contributionDiagnostics.STATUS_PENDING,
    });
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
    if (!jwtPayload || jwtPayload.sub !== campaign_id) {
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

router.get(
  '/campaign/:campaignId',
  requireAuth,
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
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [campaignId],
      limit,
      offset
    );

    return res.json({ contributions, total, limit, offset });
  })
);

router.get(
  '/quote',
  requireAuth,
  contributionQuoteValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { send_asset, dest_asset, dest_amount } = req.query;

    const paths = await stellarService.getPathPaymentQuote({
      sendAsset: send_asset,
      destAsset: dest_asset,
      destAmount: dest_amount,
    });
    if (!paths.length) {
      return res
        .status(404)
        .json({ error: `No conversion path found for ${send_asset} -> ${dest_asset}` });
    }

    const best = paths[0];
    const slippageBps = contributionService.SLIPPAGE_BPS;
    const maxSendAmount = fromStroops(mulBpsCeil(toStroops(best.source_amount), 10000 + slippageBps));
    const estimatedRate = (
      parseFloat(best.destination_amount || dest_amount) / parseFloat(best.source_amount)
    ).toFixed(15);

    return res.json({
      send_asset,
      dest_asset,
      dest_amount: String(dest_amount),
      quoted_source_amount: best.source_amount,
      max_send_amount: maxSendAmount,
      estimated_rate: estimatedRate,
      slippage_bps: slippageBps,
      path: best.path,
    });
  })
);

/**
 * Self-custody (Freighter) step 1: build the unsigned transaction and reserve
 * the amount against the per-contributor cap. The returned prepare_token binds
 * the reservation to the exact transaction the server built.
 */
router.post(
  '/prepare',
  requireAuth,
  contributionRateLimiter,
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, send_asset, sender_public_key } = req.body;
    const userId = req.user.userId;

    if (!campaign_id || typeof campaign_id !== 'string') {
      return res.status(400).json({ error: 'campaign_id is required' });
    }
    if (!StrKey.isValidEd25519PublicKey(String(sender_public_key || ''))) {
      return res.status(400).json({ error: 'sender_public_key must be a valid Stellar public key' });
    }
    let amountStroops;
    try {
      amountStroops = toStroops(amount);
    } catch (err) {
      return res.status(400).json({ error: `Invalid amount: ${err.message}` });
    }
    const destinationAmount = fromStroops(amountStroops);

    const { rows: statusRows } = await db.query('SELECT status FROM campaigns WHERE id = $1', [
      campaign_id,
    ]);
    if (!statusRows[0]) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (statusRows[0].status === 'disputed') {
      const disputed = campaignStateError(statusRows[0]);
      return res.status(disputed.status).json(disputed.body);
    }

    await assertUserKycVerified(userId);

    const { rows: campaignRows } = await db.query(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = $1`,
      [campaign_id]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const stateError = campaignStateError(campaign);
    if (stateError) {
      return res.status(stateError.status).json(stateError.body);
    }

    const sendAsset = send_asset || campaign.asset_type;
    if (!stellarService.getSupportedAssetCodes().includes(sendAsset)) {
      return res.status(400).json({ error: `Unsupported send_asset: ${sendAsset}` });
    }
    const contractMode = Boolean(sorobanService.isContractDepositEligible(campaign));
    if (contractMode && sendAsset !== campaign.asset_type) {
      return res.status(422).json({ error: CROSS_ASSET_CONTRACT_MESSAGE(campaign.asset_type) });
    }

    try {
      assertContributionLimits(campaign, destinationAmount);
      await assertContributorMeetsRequirements(sender_public_key, campaign_id);
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

    let unsignedXdr;
    let conversionQuote = null;
    if (contractMode) {
      unsignedXdr = await sorobanService.buildUnsignedEscrowDeposit({
        contractId: campaign.escrow_contract_id,
        fromAddress: sender_public_key,
        amount:
          amountStroops <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amountStroops) : amountStroops,
      });
    } else if (sendAsset === campaign.asset_type) {
      unsignedXdr = await stellarService.buildUnsignedContributionPayment({
        senderPublicKey: sender_public_key,
        destinationPublicKey: campaign.wallet_public_key,
        asset: sendAsset,
        amount: destinationAmount,
        memo: contributionService.buildContributionMemo(campaign.id),
      });
    } else {
      const intent = await contributionService.buildContributionIntent({
        campaign,
        amount: destinationAmount,
        sendAsset,
        contributorPublicKey: sender_public_key,
      });
      conversionQuote = intent.conversionQuote;
      unsignedXdr = await stellarService.buildUnsignedContributionPathPayment({
        senderPublicKey: sender_public_key,
        destinationPublicKey: campaign.wallet_public_key,
        sendAsset,
        sendMax: intent.sendMax,
        destAmount: destinationAmount,
        destAssetCode: campaign.asset_type,
        memo: contributionService.buildContributionMemo(campaign.id),
      });
    }

    const expiresAt = new Date(Date.now() + PREPARE_TOKEN_TTL_S * 1000);
    const client = await db.connect();
    let reservationId;
    try {
      await client.query('BEGIN');

      const capError = await checkPerUserCap(client, campaign, sender_public_key, destinationAmount);
      if (capError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: capError });
      }

      const { rows } = await client.query(
        `INSERT INTO stellar_transactions
           (kind, status, campaign_id, initiated_by_user_id, sender_public_key, amount,
            expires_at, unsigned_xdr, metadata)
         VALUES ('contribution', 'reserved', $1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          campaign.id,
          userId,
          sender_public_key,
          destinationAmount,
          expiresAt,
          unsignedXdr,
          JSON.stringify({
            flow: 'freighter',
            send_asset: sendAsset,
            dest_asset: campaign.asset_type,
            contract_mode: contractMode,
          }),
        ]
      );
      reservationId = rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const prepareToken = jwt.sign(
      {
        typ: PREPARE_TOKEN_TYPE,
        rid: reservationId,
        uid: userId,
        cid: campaign.id,
        sender: sender_public_key,
        amount: destinationAmount,
        asset: campaign.asset_type,
        send_asset: sendAsset,
        dest: campaign.wallet_public_key,
        contract_mode: contractMode,
        xdr: unsignedXdr,
      },
      process.env.JWT_SECRET,
      { expiresIn: PREPARE_TOKEN_TTL_S }
    );

    return res.json({
      prepare_token: prepareToken,
      unsigned_xdr: unsignedXdr,
      sender_public_key,
      network_name: isTestnet ? 'TESTNET' : 'PUBLIC',
      network_passphrase: networkPassphrase,
      expires_at: expiresAt.toISOString(),
      contract_mode: contractMode,
      conversion_quote: conversionQuote,
    });
  })
);

/**
 * Self-custody (Freighter) step 2: verify the signed XDR is exactly the
 * transaction prepared in step 1, consume the reservation and submit.
 */
router.post(
  '/submit-signed',
  requireAuth,
  contributionRateLimiter,
  asyncHandler(async (req, res) => {
    const { prepare_token, signed_xdr } = req.body;
    const userId = req.user.userId;
    if (!prepare_token || !signed_xdr) {
      return res.status(400).json({ error: 'prepare_token and signed_xdr are required' });
    }

    let claims;
    try {
      claims = jwt.verify(prepare_token, process.env.JWT_SECRET);
    } catch (err) {
      const expired = err.name === 'TokenExpiredError';
      return res
        .status(expired ? 410 : 400)
        .json({ error: expired ? 'Prepare token has expired' : 'Invalid prepare token' });
    }
    if (claims.typ !== PREPARE_TOKEN_TYPE) {
      return res.status(400).json({ error: 'Invalid prepare token' });
    }
    if (claims.uid !== userId) {
      return res.status(403).json({ error: 'Prepare token was issued to a different user' });
    }

    let signedHash;
    let preparedHash;
    try {
      signedHash = TransactionBuilder.fromXDR(signed_xdr, networkPassphrase).hash().toString('hex');
      preparedHash = TransactionBuilder.fromXDR(claims.xdr, networkPassphrase)
        .hash()
        .toString('hex');
    } catch {
      return res.status(400).json({ error: 'Invalid transaction XDR' });
    }
    if (signedHash !== preparedHash) {
      return res
        .status(422)
        .json({ error: 'Signed transaction does not match the prepared transaction' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT status, max_contribution, max_per_user, asset_type FROM campaigns WHERE id = $1',
      [claims.cid]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const stateError = campaignStateError(campaign);
    if (stateError) {
      return res.status(stateError.status).json(stateError.body);
    }
    if (campaign.max_contribution && parseFloat(claims.amount) > parseFloat(campaign.max_contribution)) {
      return res.status(400).json({
        error: `Maximum contribution is ${campaign.max_contribution} ${campaign.asset_type}`,
      });
    }

    const { rows: reservationRows } = await db.query(
      `SELECT id, status, amount, expires_at FROM stellar_transactions
       WHERE id = $1 AND kind = 'contribution'`,
      [claims.rid]
    );
    const reservation = reservationRows[0];
    if (
      !reservation ||
      reservation.status !== 'reserved' ||
      (reservation.expires_at && new Date(reservation.expires_at).getTime() < Date.now())
    ) {
      return res
        .status(410)
        .json({ error: 'This contribution reservation has expired or was already used' });
    }

    let txHash;
    try {
      if (claims.contract_mode && typeof sorobanService.submitSignedContractCall === 'function') {
        txHash = (await sorobanService.submitSignedContractCall(signed_xdr)).hash;
      } else {
        txHash = await stellarService.submitPreparedTransaction(signed_xdr);
      }
    } catch (err) {
      await db
        .query(
          `UPDATE stellar_transactions SET status = 'failed', failure_reason = $2, updated_at = NOW()
           WHERE id = $1 AND status = 'reserved'`,
          [reservation.id, err.message]
        )
        .catch(() => {});
      err.statusCode = err.statusCode || 502;
      throw err;
    }

    const { rows: updated } = await db.query(
      `UPDATE stellar_transactions
       SET status = 'submitted', unsigned_xdr = $2, signed_xdr = $3, tx_hash = $4, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [reservation.id, claims.xdr, signed_xdr, txHash]
    );

    // Contract deposits have no classic payment for the ledger stream to
    // replay, so record the contribution synchronously.
    if (claims.contract_mode) {
      try {
        await ledgerMonitor.recordConfirmedContribution({
          campaignId: claims.cid,
          walletPublicKey: claims.dest,
          senderPublicKey: claims.sender,
          destinationAmount: parseFloat(claims.amount),
          destinationAsset: claims.asset,
          paymentType: 'payment',
          txHash,
        });
      } catch (err) {
        logger.error('Failed to record contract-mode Freighter contribution', {
          tx_hash: txHash,
          error: err.message,
        });
      }
    }

    return res.status(202).json({
      success: true,
      tx_hash: txHash,
      stellar_transaction_id: updated[0]?.id || reservation.id,
      contract_mode: Boolean(claims.contract_mode),
    });
  })
);

router.get(
  '/finalization/:txHash',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT st.id, st.status, st.tx_hash, st.campaign_id, st.contribution_id,
              st.initiated_by_user_id, st.metadata, st.failure_reason, st.created_at, st.updated_at,
              c.creator_id,
              ct.id AS contribution_row_id, ct.sender_public_key, ct.amount, ct.asset,
              ct.created_at AS contribution_created_at
       FROM stellar_transactions st
       JOIN campaigns c ON c.id = st.campaign_id
       LEFT JOIN contributions ct ON ct.id = st.contribution_id
       WHERE st.tx_hash = $1 AND st.kind = 'contribution'
       LIMIT 1`,
      [req.params.txHash]
    );
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    let allowed =
      req.user?.role === 'admin' ||
      row.initiated_by_user_id === req.user.userId ||
      row.creator_id === req.user.userId;
    if (!allowed && row.sender_public_key) {
      const { rows: userRows } = await db.query(
        'SELECT wallet_public_key FROM users WHERE id = $1',
        [req.user.userId]
      );
      allowed = userRows[0]?.wallet_public_key === row.sender_public_key;
    }
    if (!allowed) {
      return res.status(403).json({ error: 'Not authorized to view this transaction' });
    }

    const finalizationStatus =
      row.status === 'indexed' ? 'finalized' : row.status === 'failed' ? 'failed' : 'pending';

    return res.json({
      tx_hash: row.tx_hash,
      status: row.status,
      finalization_status: finalizationStatus,
      failure_reason: row.failure_reason || null,
      campaign_id: row.campaign_id,
      contribution: row.contribution_row_id
        ? {
            id: row.contribution_row_id,
            sender_public_key: row.sender_public_key,
            amount: row.amount,
            asset: row.asset,
            created_at: row.contribution_created_at,
          }
        : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  })
);

router.post(
  '/:id/refund',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT ct.id, ct.sender_public_key, ct.contract_refunded_at, ct.contract_refund_tx_hash,
              c.status AS campaign_status, c.escrow_contract_id
       FROM contributions ct
       JOIN campaigns c ON c.id = ct.campaign_id
       WHERE ct.id = $1`,
      [id]
    );
    const contribution = rows[0];
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    const { rows: userRows } = await db.query('SELECT wallet_public_key FROM users WHERE id = $1', [
      req.user.userId,
    ]);
    if (!userRows[0] || userRows[0].wallet_public_key !== contribution.sender_public_key) {
      return res.status(403).json({ error: 'Not authorized to refund this contribution' });
    }

    if (contribution.campaign_status !== 'failed') {
      return res.status(400).json({
        error: 'Refunds are only available for failed campaigns',
        campaign_status: contribution.campaign_status,
        eligibility: { eligible: false, reason: 'campaign_not_failed' },
      });
    }
    if (contribution.contract_refunded_at) {
      return res.status(409).json({
        error: 'This contribution has already been refunded',
        tx_hash: contribution.contract_refund_tx_hash,
      });
    }
    if (!contribution.escrow_contract_id) {
      return res.status(400).json({
        error: 'This campaign does not use a contract-backed treasury',
        campaign_status: contribution.campaign_status,
        eligibility: { eligible: false, reason: 'no_escrow_contract' },
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
      logger.error('Contract refund failed', { contribution_id: id, error: err.message });
      return res.status(502).json({ error: err.message });
    }
    const txHash =
      typeof refundResult === 'string'
        ? refundResult
        : refundResult?.txHash || refundResult?.hash || null;

    await db.query(
      `UPDATE contributions
       SET contract_refunded_at = NOW(), contract_refund_tx_hash = $2, refunded = TRUE
       WHERE id = $1`,
      [id, txHash]
    );

    return res.json({ success: true, tx_hash: txHash });
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

    // Persist a status change (e.g. pending -> failed) so the stored diagnosis
    // stays actionable without re-hitting Horizon on every list read.
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


