const db = require('../config/database');
const { createKycSession, isKycRequiredForCampaigns } = require('./kycProvider');

function mapKycStatusForApi(dbStatus) {
  if (!dbStatus || dbStatus === 'unverified') return 'not_started';
  return dbStatus;
}

async function getKycStatusForUser(userId) {
  const { rows } = await db.query(
    `SELECT id, kyc_status, kyc_completed_at, kyc_provider_reference
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const user = rows[0];
  return {
    status: mapKycStatusForApi(user.kyc_status),
    kyc_status: user.kyc_status,
    kyc_completed_at: user.kyc_completed_at,
    provider_reference: user.kyc_provider_reference,
    kyc_required_for_campaigns: isKycRequiredForCampaigns(),
  };
}

async function startKycForUser(userId) {
  const { rows } = await db.query(
    `SELECT id, email, name, role, kyc_status
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const user = rows[0];
  if (user.kyc_status === 'verified') {
    return {
      status: 'verified',
      message: 'Identity verification is already complete.',
      user: {
        ...(await getKycStatusForUser(userId)),
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  const session = await createKycSession({ user });
  const { rows: updatedRows } = await db.query(
    `UPDATE users
     SET kyc_status = 'pending',
         kyc_provider_reference = COALESCE($2, kyc_provider_reference),
         kyc_completed_at = NULL
     WHERE id = $1
     RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at`,
    [user.id, session.providerReference || null]
  );

  return {
    status: updatedRows[0].kyc_status,
    provider: session.provider,
    provider_reference: session.providerReference,
    redirect_url: session.redirectUrl,
    session_token: session.sessionToken,
    user: {
      ...updatedRows[0],
      kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    },
  };
}

async function assertUserKycVerified(userId) {
  if (!isKycRequiredForCampaigns()) return null;

  const { rows } = await db.query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
  if (!rows.length) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  if (rows[0].kyc_status !== 'verified') {
    const err = new Error('Identity verification is required before contributing.');
    err.statusCode = 403;
    err.code = 'KYC_REQUIRED';
    err.kyc_status = rows[0].kyc_status;
    throw err;
  }

  return null;
}

module.exports = {
  getKycStatusForUser,
  startKycForUser,
  assertUserKycVerified,
  mapKycStatusForApi,
};
