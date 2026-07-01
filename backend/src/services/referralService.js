const db = require('../config/database');
const logger = require('../config/logger');

// Default reward configuration
const DEFAULT_BASE_REWARD = 1; // 1 XLM or USDC
const DEFAULT_ASSET_TYPE = 'XLM';

// Tiered bonus multipliers: referral number -> multiplier
const DEFAULT_TIER_MULTIPLIERS = {
  1: 1,   // 1st referral: 1x
  5: 2,   // 5th referral: 2x
  10: 3,  // 10th referral: 3x
  25: 5,  // 25th referral: 5x
  50: 10, // 50th referral: 10x
};

function getReferralCodeFromRequest(campaignId, req) {
  const cookieName = `cp_ref_${campaignId}`;
  return req.cookies?.[cookieName] || null;
}

/**
 * Calculate the tier level and bonus multiplier for a referral based on the referrer's total referrals.
 * @param {number} totalReferrals - The referrer's total successful referrals
 * @param {object} tierMultipliers - Custom tier multipliers (optional)
 * @returns {{tierLevel: number, multiplier: number}}
 */
function calculateTierBonus(totalReferrals, tierMultipliers = DEFAULT_TIER_MULTIPLIERS) {
  let tierLevel = 1;
  let multiplier = 1;

  // Find the highest tier threshold the user has reached
  const thresholds = Object.keys(tierMultipliers)
    .map(Number)
    .sort((a, b) => b - a);

  for (const threshold of thresholds) {
    if (totalReferrals >= threshold) {
      tierLevel = threshold;
      multiplier = tierMultipliers[threshold];
      break;
    }
  }

  return { tierLevel, multiplier };
}

/**
 * Get the total number of successful referrals for a user.
 * @param {string} userId - The user's ID
 * @returns {Promise<number>}
 */
async function getTotalReferralCount(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM campaign_referrals cr
     JOIN users u ON u.id = cr.referrer_user_id
     WHERE cr.referrer_user_id = $1`,
    [userId]
  );
  return rows[0]?.total || 0;
}

/**
 * Get the total number of contributions attributed to a user's referrals.
 * @param {string} userId - The user's ID
 * @returns {Promise<number>}
 */
async function getTotalReferralContributions(userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(contribution_count), 0)::int AS total
     FROM campaign_referrals
     WHERE referrer_user_id = $1`,
    [userId]
  );
  return rows[0]?.total || 0;
}

/**
 * Attribute a contribution to a referrer and create reward if applicable.
 * @param {string} campaignId - The campaign ID
 * @param {string} referralCode - The referral code
 * @param {object} client - Optional database client for transaction
 * @param {object} options - Additional options (ip, userAgent, deviceFingerprint)
 */
async function attributeContributionToReferrer(campaignId, referralCode, client, options = {}) {
  if (!referralCode) return;

  const runner = client || db;
  try {
    const { rows } = await runner.query(
      'SELECT id, referrer_user_id FROM campaign_referrals WHERE referral_code = $1 AND campaign_id = $2',
      [referralCode, campaignId]
    );
    if (rows.length) {
      const referral = rows[0];
      await runner.query(
        'UPDATE campaign_referrals SET contribution_count = contribution_count + 1 WHERE id = $1',
        [referral.id]
      );

      // Create reward for the referrer
      if (options.referredUserId) {
        const totalReferrals = await getTotalReferralCount(referral.referrer_user_id);
        const { tierLevel, multiplier } = calculateTierBonus(totalReferrals);

        const rewardAmount = DEFAULT_BASE_REWARD * multiplier;

        await runner.query(
          `INSERT INTO referral_rewards
           (referrer_user_id, referred_user_id, campaign_id, referral_code, reward_type, amount, asset_type, tier_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            referral.referrer_user_id,
            options.referredUserId,
            campaignId,
            referralCode,
            'credit',
            rewardAmount,
            DEFAULT_ASSET_TYPE,
            tierLevel,
          ]
        );
      }
    }
  } catch (err) {
    logger.warn('Referral attribution failed', {
      campaign_id: campaignId,
      referral_code: referralCode,
      error: err.message,
    });
  }
}

/**
 * Get all rewards for a user with optional filtering.
 * @param {string} userId - The user's ID
 * @param {object} options - Filter options (status, limit, offset)
 * @returns {Promise<{rewards: Array, total: number}>}
 */
async function getUserRewards(userId, options = {}) {
  const { status, limit = 50, offset = 0 } = options;
  const params = [userId];
  let whereClause = '';

  if (status) {
    params.push(status);
    whereClause = `WHERE rr.status = $${params.length}`;
  }

  const { rows: rewards } = await db.query(
    `SELECT rr.id, rr.campaign_id, rr.referral_code, rr.reward_type, rr.amount,
            rr.asset_type, rr.status, rr.tier_level, rr.earned_at, rr.paid_out_at,
            c.title AS campaign_title
     FROM referral_rewards rr
     JOIN campaigns c ON c.id = rr.campaign_id
     ${whereClause ? whereClause + ' AND' : 'WHERE'} rr.referrer_user_id = $1
     ORDER BY rr.earned_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM referral_rewards rr
     ${whereClause ? whereClause + ' AND' : 'WHERE'} rr.referrer_user_id = $1`,
    params
  );

  return { rewards, total: countRows[0]?.total || 0 };
}

/**
 * Get the total earned and paid-out rewards for a user.
 * @param {string} userId - The user's ID
 * @returns {Promise<{earned: number, paidOut: number, pending: number}>}
 */
async function getUserRewardSummary(userId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'earned' THEN amount ELSE 0 END), 0)::numeric AS earned,
       COALESCE(SUM(CASE WHEN status = 'paid_out' THEN amount ELSE 0 END), 0)::numeric AS paid_out,
       COALESCE(SUM(CASE WHEN status = 'earned' THEN amount ELSE 0 END), 0)::numeric -
       COALESCE(SUM(CASE WHEN status = 'paid_out' THEN amount ELSE 0 END), 0)::numeric AS pending
      FROM referral_rewards
      WHERE referrer_user_id = $1`,
    [userId]
  );

  return {
    earned: parseFloat(rows[0]?.earned || 0),
    paidOut: parseFloat(rows[0]?.paid_out || 0),
    pending: parseFloat(rows[0]?.pending || 0),
  };
}

/**
 * Get the performance leaderboard of top referrers.
 * @param {object} options - Options (limit, offset)
 * @returns {Promise<Array>}
 */
async function getLeaderboard(options = {}) {
  const { limit = 20, offset = 0 } = options;

  const { rows } = await db.query(
    `SELECT
       u.id, u.name, u.email,
       COALESCE(SUM(rr.amount), 0)::numeric AS total_earned,
       COUNT(DISTINCT rr.id) AS total_rewards,
       COUNT(DISTINCT cr.id) AS total_referrals,
       COALESCE(SUM(cr.contribution_count), 0)::int AS total_contributions
      FROM users u
      LEFT JOIN referral_rewards rr ON rr.referrer_user_id = u.id AND rr.status = 'paid_out'
      LEFT JOIN campaign_referrals cr ON cr.referrer_user_id = u.id
      WHERE u.is_admin = FALSE
      GROUP BY u.id, u.name, u.email
      ORDER BY total_earned DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return rows;
}

/**
 * Get analytics for a user's referrals (conversion funnel).
 * @param {string} userId - The user's ID
 * @returns {Promise<object>}
 */
async function getReferralAnalytics(userId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS total_referrals,
       COALESCE(SUM(cr.click_count), 0)::int AS total_clicks,
       COALESCE(SUM(cr.contribution_count), 0)::int AS total_contributions,
       COALESCE(SUM(rr.amount), 0)::numeric AS total_rewards_earned,
       COALESCE(SUM(CASE WHEN rr.status = 'paid_out' THEN rr.amount ELSE 0 END), 0)::numeric AS total_rewards_paid
      FROM campaign_referrals cr
      LEFT JOIN referral_rewards rr ON rr.referral_code = cr.referral_code
      WHERE cr.referrer_user_id = $1`,
    [userId]
  );

  const data = rows[0] || {};
  const conversionRate = data.total_clicks > 0
    ? (data.total_contributions / data.total_clicks) * 100
    : 0;

  return {
    totalReferrals: data.total_referrals || 0,
    totalClicks: data.total_clicks || 0,
    totalContributions: data.total_contributions || 0,
    totalRewardsEarned: parseFloat(data.total_rewards_earned || 0),
    totalRewardsPaid: parseFloat(data.total_rewards_paid || 0),
    conversionRate: parseFloat(conversionRate.toFixed(2)),
  };
}

/**
 * Check for fraud patterns in referrals.
 * @param {string} referrerUserId - The referrer's user ID
 * @param {string} referredUserId - The referred user's ID
 * @param {object} options - Options (ip, deviceFingerprint)
 * @returns {Promise<{isFraud: boolean, type: string|null}>}
 */
async function checkReferralFraud(referrerUserId, referredUserId, options = {}) {
  const { ip, deviceFingerprint } = options;

  // Check if same person (same wallet or email domain patterns)
  const { rows: samePersonCheck } = await db.query(
    `SELECT 1 FROM users WHERE id = $1 AND id = $2`,
    [referrerUserId, referredUserId]
  );

  if (samePersonCheck.length > 0) {
    return { isFraud: true, type: 'same_person' };
  }

  // Check for IP clustering (multiple referrals from same IP)
  if (ip) {
    const { rows: ipCluster } = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM referral_fraud_checks
       WHERE ip_address = $1 AND fraud_type = 'ip_clustering'
       AND resolved = FALSE
       AND detected_at > NOW() - INTERVAL '24 hours'`,
      [ip]
    );

    if (ipCluster[0]?.count >= 5) {
      return { isFraud: true, type: 'ip_clustering' };
    }
  }

  // Check for device clustering
  if (deviceFingerprint) {
    const { rows: deviceCluster } = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM referral_fraud_checks
       WHERE device_fingerprint = $1 AND fraud_type = 'device_clustering'
       AND resolved = FALSE
       AND detected_at > NOW() - INTERVAL '24 hours'`,
      [deviceFingerprint]
    );

    if (deviceCluster[0]?.count >= 5) {
      return { isFraud: true, type: 'device_clustering' };
    }
  }

  return { isFraud: false, type: null };
}

/**
 * Record a fraud check for a referral.
 * @param {string} referrerUserId - The referrer's user ID
 * @param {string} referredUserId - The referred user's ID
 * @param {string} fraudType - The type of fraud detected
 * @param {object} options - Additional options
 */
async function recordFraudCheck(referrerUserId, referredUserId, fraudType, options = {}) {
  const { ip, userAgent, deviceFingerprint, notes } = options;

  await db.query(
    `INSERT INTO referral_fraud_checks
     (referrer_user_id, referred_user_id, ip_address, user_agent, device_fingerprint, fraud_type, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [referrerUserId, referredUserId, ip, userAgent, deviceFingerprint, fraudType, notes]
  );
}

/**
 * Get fraud checks for a user.
 * @param {string} userId - The user's ID
 * @param {object} options - Options (limit, offset, resolved)
 * @returns {Promise<{checks: Array, total: number}>}
 */
async function getUserFraudChecks(userId, options = {}) {
  const { limit = 50, offset = 0, resolved } = options;
  const params = [userId];
  let whereClause = 'WHERE referrer_user_id = $1';

  if (resolved !== undefined) {
    params.push(resolved);
    whereClause += ` AND resolved = $${params.length}`;
  }

  const { rows: checks } = await db.query(
    `SELECT id, referred_user_id, ip_address, device_fingerprint, fraud_type,
            detected_at, resolved, resolved_at, notes
     FROM referral_fraud_checks
     ${whereClause}
     ORDER BY detected_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM referral_fraud_checks ${whereClause}`,
    params
  );

  return { checks, total: countRows[0]?.total || 0 };
}

/**
 * Resolve a fraud check.
 * @param {string} checkId - The fraud check ID
 * @param {string} userId - The user's ID (for verification)
 */
async function resolveFraudCheck(checkId, userId) {
  await db.query(
    `UPDATE referral_fraud_checks
     SET resolved = TRUE, resolved_at = NOW()
     WHERE id = $1 AND referrer_user_id = $2 AND resolved = FALSE`,
    [checkId, userId]
  );
}

module.exports = {
  getReferralCodeFromRequest,
  attributeContributionToReferrer,
  calculateTierBonus,
  getTotalReferralCount,
  getTotalReferralContributions,
  getUserRewards,
  getUserRewardSummary,
  getLeaderboard,
  getReferralAnalytics,
  checkReferralFraud,
  recordFraudCheck,
  getUserFraudChecks,
  resolveFraudCheck,
  DEFAULT_BASE_REWARD,
  DEFAULT_ASSET_TYPE,
  DEFAULT_TIER_MULTIPLIERS,
};
