const { invokeContractReadOnly, nativeToScVal } = require('./sorobanService');
const cache = require('../utils/cache');
const logger = require('../config/logger');

const FEE_REGISTRY_CONTRACT_ID = process.env.FEE_REGISTRY_CONTRACT_ID;
const CACHE_KEY = 'platform_fee_bps';
const CREATOR_SHARE_CACHE_KEY = 'creator_share_bps';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_PLATFORM_FEE_BPS = 250; // 2.5% default
const DEFAULT_CREATOR_SHARE_BPS = 500; // 5% default

/**
 * Fetch the current platform fee from the fee registry contract.
 * @returns {Promise<number>} Platform fee in basis points
 */
async function fetchPlatformFeeFromContract() {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    logger.warn('FEE_REGISTRY_CONTRACT_ID not configured, using default platform fee');
    return DEFAULT_PLATFORM_FEE_BPS;
  }

  try {
    const feeBps = await invokeContractReadOnly({
      contractId: FEE_REGISTRY_CONTRACT_ID,
      method: 'get_fee',
      args: [],
    });

    logger.info('Fetched platform fee from contract', {
      feeBps,
      contractId: FEE_REGISTRY_CONTRACT_ID,
    });
    return Number(feeBps) || DEFAULT_PLATFORM_FEE_BPS;
  } catch (error) {
    logger.error('Failed to fetch platform fee from contract', {
      error: error.message,
      contractId: FEE_REGISTRY_CONTRACT_ID,
    });
    return DEFAULT_PLATFORM_FEE_BPS;
  }
}

/**
 * Fetch the current creator share from the fee registry contract.
 * @returns {Promise<number>} Creator share in basis points
 */
async function fetchCreatorShareFromContract() {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    logger.warn('FEE_REGISTRY_CONTRACT_ID not configured, using default creator share');
    return DEFAULT_CREATOR_SHARE_BPS;
  }

  try {
    const shareBps = await invokeContractReadOnly({
      contractId: FEE_REGISTRY_CONTRACT_ID,
      method: 'get_creator_share',
      args: [],
    });

    logger.info('Fetched creator share from contract', {
      shareBps,
      contractId: FEE_REGISTRY_CONTRACT_ID,
    });
    return Number(shareBps) || DEFAULT_CREATOR_SHARE_BPS;
  } catch (error) {
    logger.error('Failed to fetch creator share from contract', {
      error: error.message,
      contractId: FEE_REGISTRY_CONTRACT_ID,
    });
    return DEFAULT_CREATOR_SHARE_BPS;
  }
}

/**
 * Refresh the cached platform fee and creator share from the contract.
 * Called on startup and every 5 minutes via cron.
 */
async function refreshFeeCache() {
  try {
    const platformFeeBps = await fetchPlatformFeeFromContract();
    const creatorShareBps = await fetchCreatorShareFromContract();

    cache.set(CACHE_KEY, platformFeeBps, CACHE_TTL_MS);
    cache.set(CREATOR_SHARE_CACHE_KEY, creatorShareBps, CACHE_TTL_MS);

    logger.info('Fee cache refreshed', { platformFeeBps, creatorShareBps });
  } catch (error) {
    logger.error('Failed to refresh fee cache', { error: error.message });
  }
}

/**
 * Get the current platform fee from cache.
 * If not in cache, fetch from contract and cache it.
 * @returns {Promise<number>} Platform fee in basis points
 */
async function getPlatformFee() {
  let feeBps = cache.get(CACHE_KEY);

  if (feeBps === undefined) {
    feeBps = await fetchPlatformFeeFromContract();
    cache.set(CACHE_KEY, feeBps, CACHE_TTL_MS);
  }

  return feeBps;
}

/**
 * Get the current creator share from cache.
 * If not in cache, fetch from contract and cache it.
 * @returns {Promise<number>} Creator share in basis points
 */
async function getCreatorShare() {
  let shareBps = cache.get(CREATOR_SHARE_CACHE_KEY);

  if (shareBps === undefined) {
    shareBps = await fetchCreatorShareFromContract();
    cache.set(CREATOR_SHARE_CACHE_KEY, shareBps, CACHE_TTL_MS);
  }

  return shareBps;
}

/**
 * Calculate the platform fee amount for a contribution.
 * @param {number} amount - Contribution amount
 * @returns {Promise<number>} Platform fee amount
 */
async function calculatePlatformFee(amount) {
  const feeBps = await getPlatformFee();
  return (amount * feeBps) / 10000;
}

/**
 * Calculate the creator revenue share for a campaign.
 * @param {number} collectedFees - Total platform fees collected for the campaign
 * @returns {Promise<number>} Creator share amount
 */
async function calculateCreatorShare(collectedFees) {
  const shareBps = await getCreatorShare();
  return (collectedFees * shareBps) / 10000;
}

/**
 * Invalidate the fee cache (called after admin_set_fee on contract).
 */
function invalidateFeeCache() {
  cache.invalidate(CACHE_KEY);
  cache.invalidate(CREATOR_SHARE_CACHE_KEY);
  logger.info('Fee cache invalidated');
}

/**
 * Get fee registry info for API responses.
 * @returns {Promise<object>} Fee registry information
 */
async function getFeeRegistryInfo() {
  const platformFeeBps = await getPlatformFee();
  const creatorShareBps = await getCreatorShare();

  return {
    platform_fee_bps: platformFeeBps,
    platform_fee_percent: (platformFeeBps / 100).toFixed(2),
    creator_share_bps: creatorShareBps,
    creator_share_percent: (creatorShareBps / 100).toFixed(2),
    contract_id: FEE_REGISTRY_CONTRACT_ID,
  };
}

module.exports = {
  refreshFeeCache,
  getPlatformFee,
  getCreatorShare,
  calculatePlatformFee,
  calculateCreatorShare,
  invalidateFeeCache,
  getFeeRegistryInfo,
  fetchPlatformFeeFromContract,
  fetchCreatorShareFromContract,
};
