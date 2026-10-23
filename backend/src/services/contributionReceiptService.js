const {
  generateContributionReceiptPdf,
  generateTaxReceiptsPdfBuffer,
} = require('./taxReceiptPdf');
const { buildStellarVerificationReference } = require('../utils/stellarExplorer');

function getDefaultDb() {
  return require('../config/database');
}

function getDefaultStorage() {
  try {
    return require('./storage');
  } catch {
    return null;
  }
}

function deriveDefaultMemo(campaignId, referralCode = null) {
  if (referralCode) {
    return `ref:${String(referralCode).trim()}`.slice(0, 28);
  }
  if (!campaignId) return null;
  return `cp-${String(campaignId).replace(/-/g, '').slice(0, 25)}`.slice(0, 28);
}

function buildReceiptRecord(row, { redactPii = false } = {}) {
  const txMetadata =
    row.tx_metadata && typeof row.tx_metadata === 'object' ? row.tx_metadata : {};
  const referralCode = row.referral_code || txMetadata.referral_code || null;
  const resolvedMemo =
    row.memo || txMetadata.memo || deriveDefaultMemo(row.campaign_id, referralCode);
  const destinationPublicKey =
    row.destination_public_key || row.campaign_wallet_public_key || null;
  const contractId = row.escrow_contract_id || row.contract_id || null;
  const ledgerSequence =
    row.ledger_sequence !== undefined && row.ledger_sequence !== null
      ? Number(row.ledger_sequence)
      : null;
  const pagingToken = row.paging_token || null;

  const verification = buildStellarVerificationReference({
    txHash: row.tx_hash,
    senderPublicKey: row.sender_public_key,
    destinationPublicKey,
    memo: resolvedMemo,
    ledgerSequence,
    pagingToken,
    contractId,
  });

  const privacy = row.contributor_privacy || 'full';
  const hideIdentityForViewer =
    redactPii && (privacy === 'anonymous' || privacy === 'amount_only');

  const contributorName = hideIdentityForViewer
    ? 'Anonymous Contributor'
    : row.contributor_name || row.display_name || 'Contributor';
  const contributorEmail = redactPii ? null : row.contributor_email || null;

  const platformFee =
    row.platform_fee ??
    row.platform_fee_amount ??
    txMetadata.platform_fee_amount ??
    '0';
  const networkFee = row.network_fee ?? txMetadata.network_fee ?? '0';
  const totalCharged = row.total_charged || row.source_amount || row.amount;

  return {
    id: row.id,
    receipt_id: row.id,
    campaign_id: row.campaign_id,
    campaign_title: row.campaign_title,
    campaign_status: row.campaign_status,
    campaign_creator_id: row.campaign_creator_id || null,
    campaign_creator_name: row.campaign_creator_name || null,
    contributor_user_id: row.contributor_user_id || null,
    contributor_name: contributorName,
    contributor_email: contributorEmail,
    contributor_privacy: privacy,
    sender_public_key: hideIdentityForViewer ? null : row.sender_public_key,
    destination_public_key: destinationPublicKey,
    contract_id: contractId,
    amount: row.amount,
    asset: row.asset,
    payment_type: row.payment_type || 'payment',
    source_amount: row.source_amount || null,
    source_asset: row.source_asset || null,
    conversion_rate: row.conversion_rate || null,
    platform_fee_amount: String(platformFee),
    network_fee: String(networkFee),
    total_charged: String(totalCharged),
    tx_hash: verification.tx_hash,
    memo: resolvedMemo,
    ledger_sequence: verification.ledger_sequence,
    paging_token: verification.paging_token,
    stellar_status: row.stellar_status || 'indexed',
    stellar_network: verification.network,
    network_passphrase: verification.network_passphrase,
    explorer_url: verification.explorer_url,
    horizon_tx_url: verification.horizon_tx_url,
    verification,
    created_at: row.created_at,
  };
}

function redactReceiptForViewer(receipt) {
  if (!receipt) return receipt;
  const privacy = receipt.contributor_privacy || 'full';
  const hideIdentity = privacy === 'anonymous' || privacy === 'amount_only';
  return {
    ...receipt,
    contributor_name: hideIdentity ? 'Anonymous Contributor' : receipt.contributor_name,
    contributor_email: null,
    sender_public_key: hideIdentity ? null : receipt.sender_public_key,
  };
}

async function getReceiptData(contributionId, { dbClient = null, redactPii = false } = {}) {
  const runner = dbClient || getDefaultDb();
  const query = `
    SELECT
      c.*,
      camp.title AS campaign_title,
      camp.status AS campaign_status,
      camp.creator_id AS campaign_creator_id,
      camp.wallet_public_key AS campaign_wallet_public_key,
      creator.name AS campaign_creator_name,
      u.id AS contributor_user_id,
      u.name AS contributor_name,
      u.email AS contributor_email,
      COALESCE(u.contributor_privacy, 'full') AS contributor_privacy,
      st.status AS stellar_status,
      st.metadata AS tx_metadata,
      ler.ledger_sequence,
      ler.paging_token
    FROM contributions c
    JOIN campaigns camp ON camp.id = c.campaign_id
    LEFT JOIN users u ON u.wallet_public_key = c.sender_public_key
    LEFT JOIN users creator ON creator.id = camp.creator_id
    LEFT JOIN stellar_transactions st ON st.tx_hash = c.tx_hash AND st.kind = 'contribution'
    LEFT JOIN ledger_event_receipts ler
      ON ler.campaign_id = c.campaign_id AND ler.transaction_hash = c.tx_hash
    WHERE c.id = $1
    LIMIT 1
  `;
  const { rows } = await runner.query(query, [contributionId]);
  if (rows.length === 0) {
    const err = new Error('Contribution not found');
    err.statusCode = 404;
    err.code = 'CONTRIBUTION_NOT_FOUND';
    throw err;
  }

  const row = rows[0];
  if (
    !row.tx_hash ||
    String(row.tx_hash).trim().length === 0 ||
    row.sender_public_key === 'system' ||
    row.payment_type === 'reconciliation_adjustment'
  ) {
    const err = new Error(
      'Contribution does not have a verifiable Stellar transaction reference'
    );
    err.statusCode = 422;
    err.code = 'UNVERIFIABLE_TRANSACTION';
    throw err;
  }

  return buildReceiptRecord(row, { redactPii });
}

async function listUserReceipts(
  userId,
  { contributionId = null, dbClient = null } = {}
) {
  const runner = dbClient || getDefaultDb();
  const params = [userId];
  let contributionFilter = '';
  if (contributionId) {
    params.push(contributionId);
    contributionFilter = 'AND ctr.id = $2';
  }

  const { rows } = await runner.query(
    `SELECT
       ctr.id,
       ctr.amount,
       ctr.asset,
       ctr.payment_type,
       ctr.source_amount,
       ctr.source_asset,
       ctr.conversion_rate,
       ctr.platform_fee_amount,
       ctr.display_name,
       ctr.tx_hash,
       ctr.created_at,
       ctr.sender_public_key,
       c.id AS campaign_id,
       c.title AS campaign_title,
       c.status AS campaign_status,
       c.creator_id AS campaign_creator_id,
       c.wallet_public_key AS campaign_wallet_public_key,
       creator.name AS campaign_creator_name,
       u.id AS contributor_user_id,
       u.name AS contributor_name,
       u.email AS contributor_email,
       COALESCE(u.contributor_privacy, 'full') AS contributor_privacy,
       st.status AS stellar_status,
       st.metadata AS tx_metadata,
       ler.ledger_sequence,
       ler.paging_token
     FROM users u
     JOIN contributions ctr ON ctr.sender_public_key = u.wallet_public_key
     JOIN campaigns c ON c.id = ctr.campaign_id
     LEFT JOIN users creator ON creator.id = c.creator_id
     LEFT JOIN stellar_transactions st ON st.tx_hash = ctr.tx_hash AND st.kind = 'contribution'
     LEFT JOIN ledger_event_receipts ler
       ON ler.campaign_id = ctr.campaign_id AND ler.transaction_hash = ctr.tx_hash
     WHERE u.id = $1
       AND ctr.tx_hash IS NOT NULL
       AND ctr.sender_public_key <> 'system'
       ${contributionFilter}
     ORDER BY ctr.created_at DESC`,
    params
  );

  return rows.map(row => buildReceiptRecord(row));
}

function taxReceiptFilename(receipts, fallback = 'crowdpay-tax-receipts.pdf') {
  const list = Array.isArray(receipts) ? receipts : [receipts];
  if (list.length === 1 && list[0]?.id) {
    const safeId = String(list[0].id).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `crowdpay-tax-receipt-${safeId}.pdf`;
  }
  return fallback;
}

async function generateReceiptPdfBuffer(receiptOrReceipts) {
  return generateTaxReceiptsPdfBuffer(receiptOrReceipts);
}

async function getOrCreateReceiptPdf(
  contributionId,
  forceRegenerate = false,
  { dbClient = null, storageClient = null } = {}
) {
  const row = await getReceiptData(contributionId, { dbClient });
  const storageKey = `receipts/${contributionId}.pdf`;
  const storage = storageClient || getDefaultStorage();

  if (
    !forceRegenerate &&
    storage &&
    typeof storage.exists === 'function' &&
    typeof storage.getSignedUrl === 'function'
  ) {
    const exists = await storage.exists(storageKey);
    if (exists) {
      return await storage.getSignedUrl(storageKey);
    }
  }

  const receiptData = {
    id: row.id,
    campaignId: row.campaign_id,
    campaignTitle: row.campaign_title,
    campaignStatus: row.campaign_status,
    contributorName: row.contributor_name || 'Contributor',
    contributorEmail: row.contributor_email || '',
    senderPublicKey: row.sender_public_key,
    destinationPublicKey: row.destination_public_key,
    amount: row.amount,
    asset: row.asset,
    paymentType: row.payment_type,
    sourceAmount: row.source_amount,
    sourceAsset: row.source_asset,
    date: row.created_at,
    txHash: row.tx_hash,
    memo: row.memo,
    ledgerSequence: row.ledger_sequence,
    stellarNetwork: row.stellar_network,
    networkPassphrase: row.network_passphrase,
    explorerUrl: row.explorer_url,
    horizonTxUrl: row.horizon_tx_url,
    verification: row.verification,
    networkFee: row.network_fee || '0',
    platformFee: row.platform_fee_amount || '0',
    totalCharged: row.total_charged || row.amount,
  };

  const pdfBuffer = await new Promise((resolve, reject) => {
    generateContributionReceiptPdf(receiptData, (err, buffer) => {
      if (err) reject(err);
      else resolve(buffer);
    });
  });

  if (
    storage &&
    typeof storage.upload === 'function' &&
    typeof storage.getSignedUrl === 'function'
  ) {
    await storage.upload(storageKey, pdfBuffer, 'application/pdf');
    return await storage.getSignedUrl(storageKey);
  }

  return pdfBuffer;
}

module.exports = {
  deriveDefaultMemo,
  buildReceiptRecord,
  redactReceiptForViewer,
  getReceiptData,
  listUserReceipts,
  taxReceiptFilename,
  generateReceiptPdfBuffer,
  getOrCreateReceiptPdf,
};
