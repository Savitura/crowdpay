const crypto = require('crypto');
const redis = require('../config/redis');
const { IMPACT_CACHE_TTL_SECONDS } = require('../config/constants');
const { Contribution, Campaign } = require('../models');

async function getImpactStats(campaignId) {
  const cacheKey = `impact:${campaignId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const [contributions, campaign] = await Promise.all([
    Contribution.findAll({
      where: { campaignId, status: 'confirmed' },
      attributes: ['amount', 'assetCode', 'contributorPublicKey'],
    }),
    Campaign.findByPk(campaignId, { attributes: ['currency'] }),
  ]);

  const stats = computeStats(contributions, campaign && campaign.currency);
  await redis.set(cacheKey, JSON.stringify(stats), 'EX', IMPACT_CACHE_TTL_SECONDS);
  return stats;
}

function computeStats(contributions, currency) {
  const amounts = contributions.map(c => Number(c.amount));
  const total = amounts.reduce((sum, a) => sum + a, 0);
  const count = amounts.length;
  const uniqueContributorCount = new Set(contributions.map(c => c.contributorPublicKey)).size;
  const average = count ? total / count : 0;
  const largest = count ? Math.max(...amounts) : 0;
  return {
    total_raised: total,
    contribution_count: count,
    average_contribution: average,
    largest_contribution: largest,
    unique_contributor_count: uniqueContributorCount,
    currency,
  };
}

function signStats(stats, campaignId) {
  const payload = JSON.stringify({ campaign_id: campaignId, ...stats });
  const signature = crypto.createHmac('sha256', process.env.IMPACT_SIGNING_SECRET || 'crowdpay-impact-secret')
    .update(payload)
    .digest('hex');
  return {
    ...stats,
    campaign_id: campaignId,
    signature,
    signed_at: new Date().toISOString(),
    algorithm: 'HMAC-SHA256',
  };
}

module.exports = { getImpactStats, signStats };
