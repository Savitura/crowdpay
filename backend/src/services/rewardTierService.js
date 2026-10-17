const db = require('../config/database');
const { stripHtml } = require('../lib/sanitize');

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

    const title = stripHtml(tier.title || '');
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

    const nftEnabled =
      tier.nft_enabled === true || tier.nft_enabled === 'true' || tier.nft_enabled === 1;
    const nftMetadataUrl =
      typeof tier.nft_metadata_url === 'string' && tier.nft_metadata_url.trim()
        ? stripHtml(tier.nft_metadata_url.trim()) || null
        : null;
    const nftArtworkUrl =
      typeof tier.nft_artwork_url === 'string' && tier.nft_artwork_url.trim()
        ? stripHtml(tier.nft_artwork_url.trim()) || null
        : null;

    return {
      title,
      description:
        typeof tier.description === 'string' ? stripHtml(tier.description) || null : null,
      min_amount: minAmount,
      asset_type: assetType,
      tier_limit: tierLimit,
      estimated_delivery: estimatedDelivery,
      nft_enabled: nftEnabled,
      nft_metadata_url: nftMetadataUrl,
      nft_artwork_url: nftArtworkUrl,
    };
  });
}

/**
 * Insert reward tiers for a campaign. Runs on a provided client so it can join
 * an existing transaction (e.g. campaign creation).
 */
async function insertTiers(client, campaignId, normalizedTiers) {
  const createdTiers = [];
  for (const tier of normalizedTiers) {
    const { rows } = await client.query(
      `INSERT INTO reward_tiers
         (campaign_id, title, description, min_amount, asset_type, tier_limit, estimated_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title`,
      [
        campaignId,
        tier.title,
        tier.description,
        tier.min_amount,
        tier.asset_type,
        tier.tier_limit,
        tier.estimated_delivery,
      ]
    );
    const insertedTier = rows[0];
    if (tier.nft_enabled) {
      await client.query(
        `INSERT INTO nft_rewards
           (reward_tier_id, campaign_id, status, metadata_url, artwork_url)
         VALUES ($1, $2, 'configured', $3, $4)`,
        [insertedTier.id, campaignId, tier.nft_metadata_url, tier.nft_artwork_url]
      );
    }
    createdTiers.push({
      id: insertedTier.id,
      title: insertedTier.title,
      nft_enabled: tier.nft_enabled,
    });
  }
  return createdTiers;
}

/**
 * List a campaign's tiers with remaining availability.
 * remaining = null for unlimited tiers, otherwise tier_limit - claimed_count.
 */
async function listTiersWithAvailability(campaignId) {
  const { rows } = await db.query(
    `SELECT rt.id, rt.campaign_id, rt.title, rt.description, rt.min_amount, rt.asset_type,
            rt.tier_limit, rt.claimed_count, rt.estimated_delivery, rt.created_at,
            CASE WHEN rt.tier_limit IS NULL THEN NULL
                 ELSE GREATEST(rt.tier_limit - rt.claimed_count, 0) END AS remaining,
            (rt.tier_limit IS NOT NULL AND rt.claimed_count >= rt.tier_limit) AS sold_out,
            EXISTS (
              SELECT 1
              FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id
                AND nr.contribution_id IS NULL
            ) AS nft_enabled,
            (
              SELECT nr.metadata_url
              FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id
                AND nr.contribution_id IS NULL
              ORDER BY nr.created_at ASC
              LIMIT 1
            ) AS nft_metadata_url,
            (
              SELECT nr.artwork_url
              FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id
                AND nr.contribution_id IS NULL
              ORDER BY nr.created_at ASC
              LIMIT 1
            ) AS nft_artwork_url
       FROM reward_tiers rt
      WHERE rt.campaign_id = $1
      ORDER BY rt.min_amount ASC`,
    [campaignId]
  );
  return rows;
}

/**
 * Reserve a slot in a specific reward tier by incrementing its claimed_count.
 *
 * Called from the contribution route INSIDE its transaction so the tier slot
 * is atomically reserved alongside the Stellar transaction submission. If the
 * tier is already sold out (claimed_count >= tier_limit with a finite limit)
 * the UPDATE returns zero rows and the caller should reject the contribution
 * with HTTP 409.
 *
 * @param {object} client   Database client inside an open transaction
 * @param {{tierId: string, campaignId: string}} params
 * @returns {{id: string, title: string}|null} the reserved tier, or null if sold out
 */
async function reserveTierSlot(client, { tierId, campaignId }) {
  const { rows } = await client.query(
    `UPDATE reward_tiers
        SET claimed_count = claimed_count + 1
      WHERE id = $1
        AND campaign_id = $2
        AND (tier_limit IS NULL OR claimed_count < tier_limit)
      RETURNING id, title`,
    [tierId, campaignId]
  );
  return rows[0] || null;
}

/**
 * Match a contribution to the highest reward tier it qualifies for that still
 * has capacity, record it, and increment that tier's claimed_count.
 *
 * When an explicit tierId is provided (pre-reserved via reserveTierSlot) the
 * function only creates the contribution_rewards join row without bumping
 * claimed_count (the slot was already reserved in the route transaction).
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
 * @param {object}   client  Database client inside an open transaction
 * @param {{campaignId: string, amount: number, contributionId: string, tierId?: string}} params
 * @returns {{id: string, title: string}|null} the assigned tier, or null if none matched
 */
async function assignTierToContribution(client, { campaignId, amount, contributionId, tierId }) {
  if (tierId) {
    // Explicit tier — slot was already reserved by the contribution route.
    // Only create the contribution_rewards join row; do NOT bump claimed_count
    // again because reserveTierSlot already did that atomically.
    const { rows } = await client.query(
      `WITH ins AS (
         INSERT INTO contribution_rewards (contribution_id, reward_tier_id)
         VALUES ($1, $2)
         ON CONFLICT (contribution_id) DO NOTHING
         RETURNING reward_tier_id
       )
       SELECT r.id, r.title,
              EXISTS (
                SELECT 1
                FROM nft_rewards nr
                WHERE nr.reward_tier_id = r.id
                  AND nr.contribution_id IS NULL
              ) AS nft_enabled,
              (
                SELECT nr.metadata_url
                FROM nft_rewards nr
                WHERE nr.reward_tier_id = r.id
                  AND nr.contribution_id IS NULL
                ORDER BY nr.created_at ASC
                LIMIT 1
              ) AS nft_metadata_url,
              (
                SELECT nr.artwork_url
                FROM nft_rewards nr
                WHERE nr.reward_tier_id = r.id
                  AND nr.contribution_id IS NULL
                ORDER BY nr.created_at ASC
                LIMIT 1
              ) AS nft_artwork_url
         FROM reward_tiers r
         JOIN ins ON ins.reward_tier_id = r.id`,
      [contributionId, tierId]
    );
    return rows[0] || null;
  }

  // Auto-match to the highest qualifying tier (legacy behaviour)
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
      RETURNING t.id, t.title,
                EXISTS (
                  SELECT 1
                  FROM nft_rewards nr
                  WHERE nr.reward_tier_id = t.id
                    AND nr.contribution_id IS NULL
                ) AS nft_enabled,
                (
                  SELECT nr.metadata_url
                  FROM nft_rewards nr
                  WHERE nr.reward_tier_id = t.id
                    AND nr.contribution_id IS NULL
                  ORDER BY nr.created_at ASC
                  LIMIT 1
                ) AS nft_metadata_url,
                (
                  SELECT nr.artwork_url
                  FROM nft_rewards nr
                  WHERE nr.reward_tier_id = t.id
                    AND nr.contribution_id IS NULL
                  ORDER BY nr.created_at ASC
                  LIMIT 1
                ) AS nft_artwork_url`,
    [campaignId, amount, contributionId]
  );
  return rows[0] || null;
}

module.exports = {
  MAX_TIERS_PER_CAMPAIGN,
  validateTiersInput,
  insertTiers,
  listTiersWithAvailability,
  assignTierToContribution,
  reserveTierSlot,
};

// ─── Inventory & fulfillment (issue #958) ───────────────────────────────────
const FULFILLMENT_STATUSES = Object.freeze(['pending','processing','shipped','delivered','cancelled','refunded']);
const FULFILLMENT_TRANSITIONS = Object.freeze({
  pending:    ['processing','shipped','cancelled','refunded'],
  processing: ['shipped','cancelled','refunded'],
  shipped:    ['delivered','refunded'],
  delivered:  [], cancelled: [], refunded: [],
});

function normalizeInventoryFields(tier, label) {
  let inventoryLimit = null;
  if (tier.inventory_limit !== undefined && tier.inventory_limit !== null && tier.inventory_limit !== '') {
    inventoryLimit = Number(tier.inventory_limit);
    if (!Number.isInteger(inventoryLimit) || inventoryLimit <= 0)
      throw new Error(`${label}: inventory_limit must be a positive whole number`);
  }
  const fulfillmentRequired = tier.fulfillment_required === true || tier.fulfillment_required === 'true' || tier.fulfillment_required === 1;
  const fulfillmentInstructions = typeof tier.fulfillment_instructions === 'string' && tier.fulfillment_instructions.trim()
    ? stripHtml(tier.fulfillment_instructions.trim()).slice(0, 2000) : null;
  if (inventoryLimit !== null && !fulfillmentRequired)
    throw new Error(`${label}: fulfillment_required must be true when inventory_limit is set`);
  return { inventoryLimit, fulfillmentRequired, fulfillmentInstructions };
}

async function reserveInventory(client, { tierId, contributionId, quantity = 1 }) {
  const { rows } = await client.query(`SELECT claim_reward_tier_inventory($1, $2) AS ok`, [tierId, quantity]);
  if (rows[0]?.ok !== true) return false;
  await client.query(
    `INSERT INTO reward_tier_inventory_reservations (reward_tier_id, contribution_id, quantity, status)
     VALUES ($1, $2, $3, 'reserved')
     ON CONFLICT (reward_tier_id, contribution_id) DO NOTHING`,
    [tierId, contributionId, quantity]);
  return true;
}

async function releaseInventory(client, { tierId, contributionId }) {
  const { rows } = await client.query(
    `UPDATE reward_tier_inventory_reservations SET status = 'released', updated_at = NOW()
      WHERE reward_tier_id = $1 AND contribution_id = $2 AND status = 'reserved' RETURNING quantity`,
    [tierId, contributionId]);
  const qty = rows[0]?.quantity;
  if (!qty) return false;
  await client.query(`UPDATE reward_tiers SET inventory_claimed = GREATEST(inventory_claimed - $2, 0) WHERE id = $1`, [tierId, qty]);
  return true;
}

async function claimInventory(client, { tierId, contributionId }) {
  const { rows } = await client.query(
    `UPDATE reward_tier_inventory_reservations SET status = 'claimed', updated_at = NOW()
      WHERE reward_tier_id = $1 AND contribution_id = $2 AND status = 'reserved' RETURNING quantity`,
    [tierId, contributionId]);
  return rows[0]?.quantity || 0;
}

async function createFulfillment(client, { contributionId, tierId, campaignId, userId, shipping }) {
  const s = shipping || {};
  const { rows } = await client.query(
    `INSERT INTO reward_fulfillments
       (contribution_id, reward_tier_id, campaign_id, user_id,
        shipping_name, shipping_address_line1, shipping_address_line2,
        shipping_city, shipping_region, shipping_postal_code, shipping_country)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (contribution_id, reward_tier_id) DO UPDATE SET updated_at = NOW()
     RETURNING id, status`,
    [contributionId, tierId, campaignId, userId,
     s.name || null, s.address_line1 || null, s.address_line2 || null,
     s.city || null, s.region || null, s.postal_code || null, s.country || null]);
  return rows[0];
}

async function getFulfillment(fulfillmentId) {
  const { rows } = await db.query(
    `SELECT rf.*, rt.title AS tier_title, c.title AS campaign_title
       FROM reward_fulfillments rf
       JOIN reward_tiers rt ON rt.id = rf.reward_tier_id
       JOIN campaigns c ON c.id = rf.campaign_id
      WHERE rf.id = $1`, [fulfillmentId]);
  return rows[0] || null;
}

async function getFulfillmentsByCampaign(campaignId, { status } = {}) {
  const params = [campaignId];
  let where = 'WHERE rf.campaign_id = $1';
  if (status) { params.push(status); where += ` AND rf.status = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT rf.*, rt.title AS tier_title, u.email AS contributor_email
       FROM reward_fulfillments rf
       JOIN reward_tiers rt ON rt.id = rf.reward_tier_id
       LEFT JOIN users u ON u.id = rf.user_id
       ${where}
      ORDER BY rf.created_at ASC`, params);
  return rows;
}

async function getFulfillmentsByUser(userId) {
  const { rows } = await db.query(
    `SELECT rf.*, rt.title AS tier_title, c.title AS campaign_title
       FROM reward_fulfillments rf
       JOIN reward_tiers rt ON rt.id = rf.reward_tier_id
       JOIN campaigns c ON c.id = rf.campaign_id
      WHERE rf.user_id = $1
      ORDER BY rf.created_at DESC`, [userId]);
  return rows;
}

async function updateFulfillmentStatus(fulfillmentId, status, { trackingNumber, carrier, notes } = {}) {
  if (!FULFILLMENT_STATUSES.includes(status)) throw new Error(`Unknown fulfillment status: ${status}`);
  const current = await getFulfillment(fulfillmentId);
  if (!current) { const e = new Error('Fulfillment not found'); e.statusCode = 404; throw e; }
  const allowed = FULFILLMENT_TRANSITIONS[current.status] || [];
  if (current.status !== status && !allowed.includes(status)) {
    const e = new Error(`Cannot transition fulfillment from ${current.status} to ${status}`);
    e.statusCode = 409; throw e;
  }
  const { rows } = await db.query(
    `UPDATE reward_fulfillments
        SET status = $2,
            tracking_number = COALESCE($3, tracking_number),
            carrier = COALESCE($4, carrier),
            notes = COALESCE($5, notes),
            fulfilled_at = CASE WHEN $2 IN ('shipped','delivered') THEN COALESCE(fulfilled_at, NOW()) ELSE fulfilled_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [fulfillmentId, status, trackingNumber || null, carrier || null, notes || null]);
  return rows[0];
}

async function getCampaignFulfillmentSummary(campaignId) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM reward_fulfillments WHERE campaign_id = $1 GROUP BY status`,
    [campaignId]);
  const summary = Object.fromEntries(FULFILLMENT_STATUSES.map(s => [s, 0]));
  for (const r of rows) summary[r.status] = r.count;
  return summary;
}

module.exports.reserveInventory = reserveInventory;
module.exports.releaseInventory = releaseInventory;
module.exports.claimInventory = claimInventory;
module.exports.createFulfillment = createFulfillment;
module.exports.getFulfillment = getFulfillment;
module.exports.getFulfillmentsByCampaign = getFulfillmentsByCampaign;
module.exports.getFulfillmentsByUser = getFulfillmentsByUser;
module.exports.updateFulfillmentStatus = updateFulfillmentStatus;
module.exports.getCampaignFulfillmentSummary = getCampaignFulfillmentSummary;
module.exports.normalizeInventoryFields = normalizeInventoryFields;
module.exports.FULFILLMENT_STATUSES = FULFILLMENT_STATUSES;
