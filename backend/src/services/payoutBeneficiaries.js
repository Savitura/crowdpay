function denied(message) {
  return Object.assign(new Error(message), { statusCode: 403, code: 'BENEFICIARY_NOT_APPROVED' });
}

async function assertBeneficiaryAllowed(db, campaignId, destinationKey) {
  if (process.env.PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED !== 'true') return;
  const { rows } = await db.query(
    `SELECT 1 FROM payout_beneficiaries WHERE campaign_id = $1 AND destination_key = $2
     AND approved_by IS NOT NULL AND effective_at <= NOW() AND revoked_at IS NULL`,
    [campaignId, destinationKey]
  );
  if (!rows.length)
    throw denied('Payout beneficiary is not approved or its change delay has not elapsed');
}

async function requestBeneficiary(db, campaignId, destinationKey, actorId) {
  if (!/^G[A-Z2-7]{55}$/.test(destinationKey)) throw new Error('Invalid Stellar public key');
  const { rows } = await db.query(
    `INSERT INTO payout_beneficiaries (campaign_id, destination_key, requested_by)
     SELECT id, $2, $3 FROM campaigns WHERE id = $1 AND creator_id = $3
     ON CONFLICT (campaign_id, destination_key) DO UPDATE
       SET requested_by = EXCLUDED.requested_by, requested_at = NOW(),
           approved_by = NULL, effective_at = NULL, revoked_at = NULL
     RETURNING campaign_id, destination_key`,
    [campaignId, destinationKey, actorId]
  );
  if (!rows.length) throw denied('Only the campaign creator can request a beneficiary');
  return rows[0];
}

async function approveBeneficiary(db, campaignId, destinationKey, actorId) {
  const { rows } = await db.query(
    `UPDATE payout_beneficiaries b SET approved_by = $3,
       effective_at = NOW() + INTERVAL '24 hours'
     WHERE campaign_id = $1 AND destination_key = $2
       AND requested_by <> $3 AND approved_by IS NULL AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM users WHERE id = $3 AND is_admin IS TRUE)
     RETURNING campaign_id, destination_key, effective_at`,
    [campaignId, destinationKey, actorId]
  );
  if (!rows.length) throw denied('An independent administrator must approve a pending beneficiary');
  return rows[0];
}

async function revokeBeneficiary(db, campaignId, destinationKey, actorId) {
  const { rows } = await db.query(
    `UPDATE payout_beneficiaries SET revoked_at = NOW()
     WHERE campaign_id = $1 AND destination_key = $2
       AND EXISTS (SELECT 1 FROM users WHERE id = $3 AND is_admin IS TRUE)
     RETURNING campaign_id, destination_key`,
    [campaignId, destinationKey, actorId]
  );
  if (!rows.length) throw denied('Administrator approval is required for revocation');
  return rows[0];
}
module.exports = {
  assertBeneficiaryAllowed,
  requestBeneficiary,
  approveBeneficiary,
  revokeBeneficiary,
};
