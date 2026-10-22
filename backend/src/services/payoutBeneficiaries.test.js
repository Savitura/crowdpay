const test = require('node:test');
const assert = require('node:assert/strict');
const { assertBeneficiaryAllowed, approveBeneficiary } = require('./payoutBeneficiaries');
test('allowlist preserves compatibility when disabled and fails closed when enabled', async () => {
  const previous = process.env.PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED;
  try {
    delete process.env.PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED;
    await assertBeneficiaryAllowed({}, 'campaign', 'key');
    process.env.PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED = 'true';
    await assert.rejects(
      assertBeneficiaryAllowed({ query: async () => ({ rows: [] }) }, 'campaign', 'key'),
      /not approved/
    );
    await assertBeneficiaryAllowed(
      {
        query: async sql => {
          assert.ok(sql.includes('effective_at <= NOW()'));
          assert.ok(sql.includes('revoked_at IS NULL'));
          return { rows: [{}] };
        },
      },
      'campaign',
      'key'
    );
  } finally {
    if (previous === undefined) delete process.env.PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED;
    else process.env.PAYOUT_BENEFICIARY_ALLOWLIST_ENABLED = previous;
  }
});
test('approval requires an independent admin and imposes a non-configurable 24-hour delay', async () => {
  await assert.rejects(
    approveBeneficiary(
      {
        query: async sql => {
          assert.ok(sql.includes('requested_by <> $3'));
          assert.ok(sql.includes('is_admin IS TRUE'));
          assert.ok(sql.includes("INTERVAL '24 hours'"));
          return { rows: [] };
        },
      },
      'campaign',
      'key',
      'actor'
    ),
    /independent administrator/
  );
});
