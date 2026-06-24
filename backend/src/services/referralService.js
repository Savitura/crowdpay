const db = require('../config/database');
const logger = require('../config/logger');

function getReferralCodeFromRequest(campaignId, req) {
  const cookieName = `cp_ref_${campaignId}`;
  return req.cookies?.[cookieName] || null;
}

async function attributeContributionToReferrer(campaignId, referralCode, client) {
  if (!referralCode) return;

  const runner = client || db;
  try {
    const { rows } = await runner.query(
      'SELECT id FROM campaign_referrals WHERE referral_code = $1 AND campaign_id = $2',
      [referralCode, campaignId]
    );
    if (rows.length) {
      await runner.query(
        'UPDATE campaign_referrals SET contribution_count = contribution_count + 1 WHERE id = $1',
        [rows[0].id]
      );
    }
  } catch (err) {
    logger.warn('Referral attribution failed', {
      campaign_id: campaignId,
      referral_code: referralCode,
      error: err.message,
    });
  }
}

module.exports = {
  getReferralCodeFromRequest,
  attributeContributionToReferrer,
};
