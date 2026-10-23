const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const STELLAR_TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

function normalizeNetworkName(rawNetwork) {
  const value = String(rawNetwork || process.env.STELLAR_NETWORK || 'testnet')
    .trim()
    .toLowerCase();
  if (value === 'mainnet' || value === 'public') {
    return 'public';
  }
  return value || 'testnet';
}

function getStellarNetwork(networkOverride) {
  if (networkOverride) {
    return normalizeNetworkName(networkOverride);
  }
  const raw = String(process.env.STELLAR_NETWORK || 'testnet').trim();
  if (raw.toLowerCase() === 'mainnet' || raw.toLowerCase() === 'public') {
    return 'public';
  }
  return raw || 'testnet';
}

function getStellarNetworkPassphrase(networkOverride) {
  const network = getStellarNetwork(networkOverride);
  return network === 'public' ? PUBLIC_PASSPHRASE : TESTNET_PASSPHRASE;
}

function isVerifiableStellarTxHash(txHash) {
  if (typeof txHash !== 'string') return false;
  return STELLAR_TX_HASH_REGEX.test(txHash.trim());
}

function getStellarExpertTxUrl(txHash, networkOverride) {
  if (!txHash || typeof txHash !== 'string' || !txHash.trim()) return null;
  const network = getStellarNetwork(networkOverride);
  return `https://stellar.expert/explorer/${network}/tx/${txHash.trim()}`;
}

function getStellarExpertAccountUrl(publicKey, networkOverride) {
  if (
    !publicKey ||
    typeof publicKey !== 'string' ||
    !publicKey.trim() ||
    publicKey.trim() === 'system'
  ) {
    return null;
  }
  const network = getStellarNetwork(networkOverride);
  return `https://stellar.expert/explorer/${network}/account/${publicKey.trim()}`;
}

function getHorizonBaseUrl(networkOverride) {
  const network = getStellarNetwork(networkOverride);
  const fallback =
    network === 'public'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
  if (!networkOverride && process.env.STELLAR_HORIZON_URL) {
    return process.env.STELLAR_HORIZON_URL.replace(/\/+$/, '');
  }
  return fallback;
}

function getHorizonTxUrl(txHash, networkOverride) {
  if (!txHash || typeof txHash !== 'string' || !txHash.trim()) return null;
  return `${getHorizonBaseUrl(networkOverride)}/transactions/${txHash.trim()}`;
}

/**
 * Build a canonical, independently verifiable Stellar transaction reference
 * block for contributor receipts and audit records.
 */
function buildStellarVerificationReference({
  txHash,
  network: networkOverride = null,
  senderPublicKey = null,
  destinationPublicKey = null,
  memo = null,
  ledgerSequence = null,
  pagingToken = null,
  contractId = null,
} = {}) {
  const rawHash =
    typeof txHash === 'string' && txHash.trim().length > 0 ? txHash.trim() : null;
  const verifiable = Boolean(
    rawHash && isVerifiableStellarTxHash(rawHash) && senderPublicKey !== 'system'
  );
  const normalizedTxHash = rawHash ? rawHash.toLowerCase() : null;
  const normalizedSender =
    typeof senderPublicKey === 'string' &&
    senderPublicKey.trim().length > 0 &&
    senderPublicKey.trim() !== 'system'
      ? senderPublicKey.trim()
      : null;
  const normalizedDestination =
    typeof destinationPublicKey === 'string' && destinationPublicKey.trim().length > 0
      ? destinationPublicKey.trim()
      : null;
  const network = getStellarNetwork(networkOverride);
  const networkPassphrase = getStellarNetworkPassphrase(networkOverride);

  return {
    tx_hash: normalizedTxHash,
    network,
    network_passphrase: networkPassphrase,
    explorer_url: verifiable ? getStellarExpertTxUrl(normalizedTxHash, network) : null,
    horizon_tx_url: verifiable ? getHorizonTxUrl(normalizedTxHash, network) : null,
    sender_public_key: normalizedSender,
    sender_explorer_url: normalizedSender
      ? getStellarExpertAccountUrl(normalizedSender, network)
      : null,
    destination_public_key: normalizedDestination,
    destination_explorer_url: normalizedDestination
      ? getStellarExpertAccountUrl(normalizedDestination, network)
      : null,
    contract_id: contractId || null,
    memo: memo || null,
    ledger_sequence:
      ledgerSequence !== null &&
      ledgerSequence !== undefined &&
      !Number.isNaN(Number(ledgerSequence))
        ? Number(ledgerSequence)
        : null,
    paging_token: pagingToken || null,
    verifiable,
  };
}

module.exports = {
  TESTNET_PASSPHRASE,
  PUBLIC_PASSPHRASE,
  isVerifiableStellarTxHash,
  getStellarNetwork,
  getStellarNetworkPassphrase,
  getStellarExpertTxUrl,
  getStellarExpertAccountUrl,
  getHorizonBaseUrl,
  getHorizonTxUrl,
  buildStellarVerificationReference,
};
