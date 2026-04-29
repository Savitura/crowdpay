const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { Keypair, TransactionBuilder } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const { networkPassphrase, isTestnet } = require('../config/stellar');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');
const { sendAlert } = require('../services/alerting');
const { contributionValidation, validateRequest } = require('../middleware/validation');
const {
  buildUnsignedContributionPayment,
  buildUnsignedContributionPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  getSupportedAssetCodes,
} = require('../services/stellarService');
const { insertContributionSubmitted } = require('../services/stellarTransactionService');
const { sendEmail } = require('../services/emailService');
const {
  SLIPPAGE_BPS,
  buildContributionIntent,
  buildContributionMemo,
  submitCustodialContribution,
} = require('../services/contributionService');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const PREPARED_CONTRIBUTION_EXPIRES_IN = '10m';

function validateFreighterPublicKey(publicKey) {
  try {
    Keypair.fromPublicKey(publicKey);
    return true;
  } catch (_err) {
    return false;
  }
}

async function loadActiveCampaign(campaignId) {
  const { rows } = await db.query(
    'SELECT c.*, u.email as creator_email FROM campaigns c JOIN users u ON c.creator_id = u.id WHERE c.id = $1 AND c.status = $2',
    [campaignId, 'active']
  );
  return rows[0] || null;
}

function createPreparedContributionToken(payload) {
  return jwt.sign(
    {
      kind: 'prepared_contribution',
      ...payload,
    },
    process.env.JWT_SECRET,
    { expiresIn: PREPARED_CONTRIBUTION_EXPIRES_IN }
  );
}

function verifyPreparedContributionToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (!payload || payload.kind !== 'prepared_contribution') {
    throw new Error('Invalid contribution prepare token');
  }
  return payload;
}

function validateSubmittedContributionXdr({ signedXdr, unsignedXdr, senderPublicKey }) {
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const unsignedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);

  if (signedTx.source !== senderPublicKey) {
    throw new Error('Signed transaction source account does not match the prepared contribution');
  }

  if (signedTx.hash().toString('hex') !== unsignedTx.hash().toString('hex')) {
    throw new Error('Signed transaction does not match the prepared contribution');
  }

  if (!signedTx.signatures.length) {
    throw new Error('Signed transaction is missing contributor signature');
  }

  const signer = Keypair.fromPublicKey(senderPublicKey);
  const signatureValid = signedTx.signatures.some((decoratedSignature) => {
    try {
      return signer.verify(signedTx.hash(), decoratedSignature.signature());
    } catch (_err) {
      return false;
    }
  });

  if (!signatureValid) {
    throw new Error('Signed transaction does not include a valid Freighter signature for the contributor');
  }
}

// Get contributions for a campaign
router.get('/campaign/:campaignId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.sender_public_key, c.amount, c.asset, c.payment_type,
            c.anchor_id, c.anchor_transaction_id, c.anchor_asset, c.anchor_amount,
            c.source_amount, c.source_asset, c.conversion_rate, c.path,
            c.tx_hash, c.created_at,
            wr.status AS refund_status, wr.tx_hash AS refund_tx_hash
     FROM contributions c
     LEFT JOIN LATERAL (
       SELECT status, tx_hash
       FROM withdrawal_requests
       WHERE contribution_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) wr ON TRUE
     WHERE c.campaign_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

// Trace contribution settlement by Stellar tx hash (submitted vs indexed on ledger)
router.get('/finalization/:txHash', requireAuth, async (req, res) => {
  const txHash = req.params.txHash;
  const { rows } = await db.query(
    `SELECT st.id, st.status, st.tx_hash, st.campaign_id, st.contribution_id,
            st.initiated_by_user_id, st.metadata, st.created_at, st.updated_at,
            c.creator_id,
            ct.id AS contribution_row_id, ct.sender_public_key, ct.amount,
            ct.asset, ct.created_at AS contribution_created_at
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     LEFT JOIN contributions ct ON ct.id = st.contribution_id
     WHERE st.tx_hash = $1 AND st.kind = 'contribution'`,
    [txHash]
  );
  if (!rows.length) return res.status(404).json({ error: 'No contribution transaction found' });
  const row = rows[0];

  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const userPk = userRows[0]?.wallet_public_key;
  const isInitiator = row.initiated_by_user_id === req.user.userId;
  const isCreator = row.creator_id === req.user.userId;
  const isContributor = userPk && row.sender_public_key && row.sender_public_key === userPk;
  const isPlatform = req.user.role === 'admin';

  if (!isInitiator && !isCreator && !isContributor && !isPlatform) {
    return res.status(403).json({ error: 'Not authorized to view this transaction' });
  }

  let finalizationStatus = 'awaiting_ledger';
  if (row.status === 'indexed') finalizationStatus = 'finalized';
  if (row.status === 'failed') finalizationStatus = 'failed';

  res.json({
    tx_hash: row.tx_hash,
    finalization_status: finalizationStatus,
    stellar_transaction_id: row.id,
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
    metadata: row.metadata,
    updated_at: row.updated_at,
  });
});

// Quote conversion before a path payment contribution
router.get('/quote', requireAuth, async (req, res) => {
  const { send_asset, dest_asset, dest_amount } = req.query;
  if (!send_asset || !dest_asset || !dest_amount) {
    return res.status(400).json({
      error: 'send_asset, dest_asset and dest_amount are required query params',
    });
  }
  if (!SUPPORTED_ASSETS.includes(send_asset) || !SUPPORTED_ASSETS.includes(dest_asset)) {
    return res.status(400).json({ error: `Supported assets: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  const paths = await getPathPaymentQuote({
    sendAsset: send_asset,
    destAsset: dest_asset,
    destAmount: dest_amount,
  });

  if (!paths.length) {
    return res.status(404).json({ error: 'No conversion path found for requested assets' });
  }

  const bestPath = paths[0];
  const maxSendWithSlippage = (
    parseFloat(bestPath.source_amount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);

  res.json({
    send_asset,
    dest_asset,
    dest_amount: String(dest_amount),
    quoted_source_amount: bestPath.source_amount,
    max_send_amount: maxSendWithSlippage,
    estimated_rate: (
      parseFloat(dest_amount) / parseFloat(bestPath.source_amount)
    ).toFixed(15),
    path: bestPath.path,
    path_count: paths.length,
  });
});

router.post('/prepare', requireAuth, contributionValidation, validateRequest, async (req, res) => {
  const { campaign_id, amount, send_asset, sender_public_key, display_name } = req.body;
  if (!sender_public_key) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'sender_public_key is required for Freighter contributions',
        fields: { sender_public_key: 'sender_public_key is required for Freighter contributions' },
      },
    });
  }
  if (!validateFreighterPublicKey(sender_public_key)) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'sender_public_key must be a valid Stellar public key',
        fields: { sender_public_key: 'Invalid Stellar public key' },
      },
    });
  }

  const campaign = await loadActiveCampaign(campaign_id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (campaign.min_contribution && parseFloat(amount) < parseFloat(campaign.min_contribution)) {
    return res.status(400).json({ error: `Contribution amount is below the minimum limit of ${campaign.min_contribution} ${campaign.asset_type}` });
  }

  if (campaign.max_contribution) {
    const { rows: sumRows } = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM contributions WHERE campaign_id = $1 AND sender_public_key = $2',
      [campaign_id, sender_public_key]
    );
    const totalExisting = parseFloat(sumRows[0].total);
    if (totalExisting + parseFloat(amount) > parseFloat(campaign.max_contribution)) {
      return res.status(400).json({ error: `Contribution violates the maximum limit of ${campaign.max_contribution} ${campaign.asset_type} per backer` });
    }
  }

  try {
    const intent = await buildContributionIntent({
      campaign,
      amount,
      sendAsset: send_asset,
      contributorPublicKey: sender_public_key,
      displayName: display_name,
    });

    const unsignedXdr =
      intent.kind === 'payment'
        ? await buildUnsignedContributionPayment({
            senderPublicKey: sender_public_key,
            destinationPublicKey: campaign.wallet_public_key,
            asset: send_asset,
            amount,
            memo: buildContributionMemo(campaign_id),
          })
        : await buildUnsignedContributionPathPayment({
            senderPublicKey: sender_public_key,
            destinationPublicKey: campaign.wallet_public_key,
            sendAsset: send_asset,
            sendMax: intent.sendMax,
            destAmount: amount,
            destAssetCode: campaign.asset_type,
            memo: buildContributionMemo(campaign_id),
          });

    const prepareToken = createPreparedContributionToken({
      user_id: req.user.userId,
      campaign_id,
      sender_public_key,
      unsigned_xdr: unsignedXdr,
      flow_metadata: intent.flowMetadata,
      conversion_quote: intent.conversionQuote,
    });

    res.json({
      unsigned_xdr: unsignedXdr,
      prepare_token: prepareToken,
      conversion_quote: intent.conversionQuote,
      sender_public_key,
      network_passphrase: networkPassphrase,
      network_name: isTestnet ? 'TESTNET' : 'PUBLIC',
    });
  } catch (err) {
    if (err.statusCode === 422) {
      return res.status(422).json({ error: err.message });
    }

    logger.error('Freighter contribution preparation failed', { campaign_id, error: err.message });
    return res.status(503).json({
      error: 'Could not prepare the Stellar transaction right now. Please try again.',
    });
  }
});

router.post('/submit-signed', requireAuth, async (req, res) => {
  const { signed_xdr, prepare_token } = req.body;
  if (!signed_xdr || !prepare_token) {
    return res.status(400).json({ error: 'signed_xdr and prepare_token are required' });
  }

  let txHash;
  let conversionQuote = null;
  let unsignedXdr;
  let signedXdr;
  let flowMetadata;
  let platformFeeAmount = 0;

  if (send_asset === campaign.asset_type) {
    const prepared = await prepareSignedContributionPayment({
      senderSecret,
      destinationPublicKey: campaign.wallet_public_key,
      asset: send_asset,
      amount,
      memo: `cp-${campaign_id}`,
    });
    unsignedXdr = prepared.unsignedXdr;
    signedXdr = prepared.signedXdr;
    platformFeeAmount = prepared.feeAmount || 0;
    flowMetadata = {
      flow: 'payment',
      send_asset,
      amount: String(amount),
      contributor_public_key: contributorPublicKey,
      platform_fee_amount: platformFeeAmount,
    };
  } else {
    const paths = await getPathPaymentQuote({
      sendAsset: send_asset,
      destAsset: campaign.asset_type,
      destAmount: amount,
    });
    if (!paths.length) {
      return res.status(422).json({
        error: `No conversion path found for ${send_asset} -> ${campaign.asset_type}`,
      });
    }

  if (prepared.user_id !== req.user.userId) {
    return res.status(403).json({ error: 'Prepared contribution token does not belong to this user' });
  }

  try {
    validateSubmittedContributionXdr({
      signedXdr: signed_xdr,
      unsignedXdr: prepared.unsigned_xdr,
      senderPublicKey: prepared.sender_public_key,
    });
    unsignedXdr = prepared.unsignedXdr;
    signedXdr = prepared.signedXdr;
    platformFeeAmount = prepared.feeAmount || 0;

    conversionQuote = {
      send_asset,
      campaign_asset: campaign.asset_type,
      campaign_amount: String(amount),
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: sendMax,
      path: bestPath.path,
    };
    flowMetadata = {
      flow: 'path_payment_strict_receive',
      send_asset,
      dest_asset: campaign.asset_type,
      dest_amount: String(amount),
      max_send_amount: sendMax,
      contributor_public_key: contributorPublicKey,
      platform_fee_amount: platformFeeAmount,
    };
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  let txHash;
  try {
    txHash = await submitPreparedTransaction(signed_xdr);
  } catch (err) {
    logger.error('Freighter contribution submission failed', {
      campaign_id: prepared.campaign_id,
      error: err.message,
    });
    sendAlert('Freighter contribution submission failed', {
      campaign_id: prepared.campaign_id,
      error: err.message,
    });
    return res.status(502).json({
      error: 'Stellar network rejected the transaction',
      detail: err.message || String(err),
    });
  }

  const stellarTransactionId = await insertContributionSubmitted(null, {
    txHash,
    campaignId: prepared.campaign_id,
    userId: req.user.userId,
    unsignedXdr: prepared.unsigned_xdr,
    signedXdr: signed_xdr,
    metadata: prepared.flow_metadata,
  });

  res.status(202).json({
    tx_hash: txHash,
    stellar_transaction_id: stellarTransactionId,
    message: 'Transaction submitted',
    platform_fee_amount: platformFeeAmount,
    conversion_quote: conversionQuote,
  });
});

// Contribute to a campaign (authenticated, custodial)
router.post('/', requireAuth, contributionValidation, validateRequest, async (req, res) => {
  const { campaign_id, amount, send_asset, display_name } = req.body;

  const campaign = await loadActiveCampaign(campaign_id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // Load contributor's custodial secret
  const { rows: users } = await db.query(
    'SELECT wallet_secret_encrypted, wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const contributorPublicKey = users[0].wallet_public_key;

  if (campaign.min_contribution && parseFloat(amount) < parseFloat(campaign.min_contribution)) {
    return res.status(400).json({ error: `Contribution amount is below the minimum limit of ${campaign.min_contribution} ${campaign.asset_type}` });
  }

  if (campaign.max_contribution) {
    const { rows: sumRows } = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM contributions WHERE campaign_id = $1 AND sender_public_key = $2',
      [campaign_id, contributorPublicKey]
    );
    const totalExisting = parseFloat(sumRows[0].total);
    if (totalExisting + parseFloat(amount) > parseFloat(campaign.max_contribution)) {
      return res.status(400).json({ error: `Contribution violates the maximum limit of ${campaign.max_contribution} ${campaign.asset_type} per backer` });
    }
  }

  try {
    const result = await submitCustodialContribution({
      campaign,
      campaignId: campaign_id,
      userId: req.user.userId,
      walletPublicKey: contributorPublicKey,
      walletSecretEncrypted: users[0].wallet_secret_encrypted,
      amount,
      sendAsset: send_asset,
      displayName: display_name,
    });
    res.status(202).json({
      tx_hash: result.txHash,
      stellar_transaction_id: result.stellarTransactionId,
      message: 'Transaction submitted',
      conversion_quote: result.conversionQuote,
    });
  } catch (err) {
    if (err.statusCode === 422) {
      return res.status(422).json({ error: err.message });
    }
    if (err.statusCode === 502) {
      logger.error('Stellar transaction submission failed', { campaign_id, error: err.message });
      sendAlert('Stellar transaction submission failed', { campaign_id, error: err.message });
      return res.status(502).json({
        error: 'Stellar network rejected the transaction',
        detail: err.message || String(err),
      });
    }

    logger.error('Custodial contribution signing failed', { campaign_id, error: err.message });
    return res.status(503).json({
      error: 'Wallet setup is still completing; please retry in a few seconds.',
    });
  }

  setImmediate(() => {
    sendEmail({
      to: campaign.creator_email,
      subject: `New Contribution to ${campaign.title}`,
      text: `You just received a contribution of ${amount} ${send_asset} from public key: ${contributorPublicKey}.`
    });

    if (Number(campaign.raised_amount) + Number(amount) >= Number(campaign.target_amount)) {
      sendEmail({
        to: campaign.creator_email,
        subject: `Target Reached for ${campaign.title}!`,
        text: `Congratulations! Your campaign "${campaign.title}" has reached its target of ${campaign.target_amount} ${campaign.asset_type}. You can now start the withdrawal process.`
      });
    }
  });
});

module.exports = router;
