const db = require('../config/database');

const MAX_TIERS_PER_CAMPAIGN = 10;

/**
 * Validate and normalize a reward_tiers array supplied by a campaign creator.
 *
 * Tiers are optional (0-10 per campaign). Each tier's asset_type must match the
 * campaign asset. Throws an Error with a user-friendly message on bad input.
 *
 * @param {Array|undefined} tiers   raw reward_tiers from the request body
 * @param {string} campaignAssetType  'XLM' | 'USDC'
 * @returns {Array} normalized tier objects ready for insertTiers()
 */
function validateTiersInput(tiers, campaignAssetType) {
  if (tiers === undefined || tiers === null) return [];
  if (!Array.isArray(tiers)) {
    throw new Error('reward_tiers must be an array');
  }
  if (tiers.length > MAX_TIERS_PER_CAMPAIGN) {
    throw new Error(`A campaign can have at most ${MAX_TIERS_PER_CAMPAIGN} reward tiers`);
  }

  return tiers.map((tier, index) => {
    const label = `reward_tiers[${index}]`;

    const title = typeof tier.title === 'string' ? tier.title.trim() : '';
    if (!title) throw new Error(`${label}: title is required`);

    const minAmount = Number(tier.min_amount);
    if (!Number.isFinite(minAmount) || minAmount <= 0) {
      throw new Error(`${label}: min_amount must be a positive number`);
    }

    // asset_type is optional in the request; if given it must match the campaign.
    const assetType = tier.asset_type ? String(tier.asset_type) : campaignAssetType;
    if (assetType !== campaignAssetType) {
      throw new Error(`${label}: asset_type must match the campaign asset (${campaignAssetType})`);
    }

    let tierLimit = null;
    if (tier.limit !== undefined && tier.limit !== null && tier.limit !== '') {
      tierLimit = Number(tier.limit);
      if (!Number.isInteger(tierLimit) || tierLimit <= 0) {
        throw new Error(`${label}: limit must be a positive whole number`);
      }
    }

    let estimatedDelivery = null;
    if (tier.estimated_delivery) {
      const date = new Date(tier.estimated_delivery);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`${label}: estimated_delivery must be a valid date`);
      }
      estimatedDelivery = tier.estimated_delivery;
    }

    return {
      title,
      description: typeof tier.description === 'string' ? tier.description.trim() : null,
      min_amount: minAmount,
      asset_type: assetType,
      tier_limit: tierLimit,
      estimated_delivery: estimatedDelivery,
    };
  });
}

/**
 * Insert reward tiers for a campaign. Runs on a provided client so it can join
 * an existing transaction (e.g. campaign creation).
 */
async function insertTiers(client, campaignId, normalizedTiers) {
  for (const tier of normalizedTiers) {
    await client.query(
      `INSERT INTO reward_tiers
         (campaign_id, title, description, min_amount, asset_type, tier_limit, estimated_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        campaignId,
        tier.title,
        tier.description,
        tier.min_amount,
        tier.asset_type,
        tier.tier_limit,
        tier.estimated_delivery,
      ],
    );
  }
}

/**
 * List a campaign's tiers with remaining availability.
 * remaining = null for unlimited tiers, otherwise tier_limit - claimed_count.
 */
async function listTiersWithAvailability(campaignId) {
  const { rows } = await db.query(
    `SELECT id, campaign_id, title, description, min_amount, asset_type,
            tier_limit, claimed_count, estimated_delivery, created_at,
            CASE WHEN tier_limit IS NULL THEN NULL
                 ELSE GREATEST(tier_limit - claimed_count, 0) END AS remaining,
            (tier_limit IS NOT NULL AND claimed_count >= tier_limit) AS sold_out
       FROM reward_tiers
      WHERE campaign_id = $1
      ORDER BY min_amount ASC`,
    [campaignId],
  );
  return rows;
}

/**
 * Match a contribution to the highest reward tier it qualifies for that still
 * has capacity, record it, and increment that tier's claimed_count.
 *
 * Runs on a provided client inside the contribution-indexing transaction so the
 * assignment is atomic with the contribution insert. The whole operation is a
 * single statement:
 *   - FOR UPDATE locks the chosen tier row against concurrent indexing.
 *   - ON CONFLICT (contribution_id) makes re-indexing the same contribution a
 *     no-op (idempotent), and claimed_count is only bumped on a real insert.
 *   - Full tiers are filtered out, so a contributor that can't get the top tier
 *     automatically falls back to the next qualifying one.
 *
 * @returns {{id: string, title: string}|null} the assigned tier, or null if none matched
 */
async function assignTierToContribution(client, { campaignId, amount, contributionId }) {
  const { rows } = await client.query(
    `WITH chosen AS (
       SELECT id
         FROM reward_tiers
        WHERE campaign_id = $1
          AND min_amount <= $2
          AND (tier_limit IS NULL OR claimed_count < tier_limit)
        ORDER BY min_amount DESC
        LIMIT 1
        FOR UPDATE
     ),
     ins AS (
       INSERT INTO contribution_rewards (contribution_id, reward_tier_id)
       SELECT $3, id FROM chosen
       ON CONFLICT (contribution_id) DO NOTHING
       RETURNING reward_tier_id
     )
     UPDATE reward_tiers t
        SET claimed_count = claimed_count + 1
       FROM ins
      WHERE t.id = ins.reward_tier_id
      RETURNING t.id, t.title`,
    [campaignId, amount, contributionId],
  );
  return rows[0] || null;
}

module.exports = {
  MAX_TIERS_PER_CAMPAIGN,
  validateTiersInput,
  insertTiers,
  listTiersWithAvailability,
  assignTierToContribution,
};
