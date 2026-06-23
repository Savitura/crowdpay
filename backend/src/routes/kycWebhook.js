const db = require('../config/database');
const logger = require('../config/logger');
const { extractWebhookResult, verifyPersonaWebhookSignature } = require('../services/kycProvider');
const { sendKycApprovedEmail, sendKycRejectedEmail } = require('../services/emailService');

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

async function handleKycWebhook(req, res) {
  const rawBody = req.body;
  const signatureHeader = req.headers['persona-signature'] || req.headers['Persona-Signature'];

  if (!verifyPersonaWebhookSignature(rawBody, signatureHeader)) {
    return res.status(401).json({ error: 'Invalid Persona webhook signature' });
  }

  let payload;
  try {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    payload = JSON.parse(bodyStr);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const result = extractWebhookResult(payload);
  if (!result.providerReference && !result.userId) {
    return res.status(400).json({ error: 'KYC webhook payload missing provider reference' });
  }

  if (!['verified', 'rejected', 'pending'].includes(result.kycStatus)) {
    return res.status(400).json({ error: 'Unsupported KYC status' });
  }

  const params = [result.kycStatus, result.providerReference || null];
  let lookup = 'kyc_provider_reference = $2';
  if (result.userId) {
    params.push(result.userId);
    lookup = `(kyc_provider_reference = $2 OR id = $3)`;
  }

  const { rows } = await db.query(
    `UPDATE users
     SET kyc_status = $1::kyc_status,
         kyc_provider_reference = COALESCE($2, kyc_provider_reference),
         kyc_completed_at = CASE WHEN $1::kyc_status = 'verified' THEN NOW() ELSE NULL END
     WHERE ${lookup}
     RETURNING id, email, name, kyc_status, kyc_completed_at`,
    params
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'KYC subject not found' });
  }

  if (rows[0].email) {
    if (rows[0].kyc_status === 'verified') {
      sendKycApprovedEmail({
        to: rows[0].email,
        userId: rows[0].id,
        name: rows[0].name,
        dashboardUrl: `${frontendBaseUrl()}/dashboard`,
      }).catch((err) => logger.error('KYC approved email failed', { error: err.message }));
    } else if (rows[0].kyc_status === 'rejected') {
      sendKycRejectedEmail({
        to: rows[0].email,
        userId: rows[0].id,
        name: rows[0].name,
        reason: result.reason,
        retryUrl: `${frontendBaseUrl()}/dashboard?kyc=retry`,
      }).catch((err) => logger.error('KYC rejected email failed', { error: err.message }));
    }
  }

  res.json({
    received: true,
    user_id: rows[0].id,
    kyc_status: rows[0].kyc_status,
    kyc_completed_at: rows[0].kyc_completed_at,
  });
}

module.exports = handleKycWebhook;
