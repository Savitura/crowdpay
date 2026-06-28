const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const proxyquire = require('proxyquire').noCallThru();

const originalKycRequired = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;

beforeEach(() => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';
});

afterEach(() => {
  if (originalKycRequired === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = originalKycRequired;
});

function buildKycService(kycStatus = 'pending') {
  return proxyquire('./kycService', {
    '../config/database': {
      query: async (text) => {
        if (text.includes('SELECT id, email, name, role, kyc_status')) {
          return {
            rows: [{
              id: 'user-1',
              email: 'user@test.com',
              name: 'User',
              role: 'contributor',
              kyc_status: kycStatus,
            }],
          };
        }
        if (text.includes('SELECT id, kyc_status, kyc_completed_at, kyc_provider_reference')) {
          return {
            rows: [{
              id: 'user-1',
              kyc_status: kycStatus,
              kyc_completed_at: kycStatus === 'verified' ? new Date().toISOString() : null,
              kyc_provider_reference: 'inq_1',
            }],
          };
        }
        if (text.includes('UPDATE users')) {
          return {
            rows: [{
              id: 'user-1',
              email: 'user@test.com',
              name: 'User',
              role: 'contributor',
              kyc_status: 'pending',
              kyc_completed_at: null,
              wallet_public_key: 'GUSER',
            }],
          };
        }
        if (text.includes('SELECT kyc_status FROM users')) {
          return { rows: [{ kyc_status: kycStatus }] };
        }
        return { rows: [] };
      },
    },
    './kycProvider': {
      isKycRequiredForCampaigns: () => true,
      createKycSession: async () => ({
        provider: 'dev',
        providerReference: 'inq_dev',
        redirectUrl: 'http://localhost:5173/dashboard?kyc=returned',
        sessionToken: 'tok',
      }),
    },
  });
}

test('getKycStatusForUser maps unverified to not_started', async () => {
  const kycService = buildKycService('unverified');
  const status = await kycService.getKycStatusForUser('user-1');
  assert.strictEqual(status.status, 'not_started');
  assert.strictEqual(status.kyc_status, 'unverified');
});

test('startKycForUser returns redirect URL and pending status', async () => {
  const kycService = buildKycService('unverified');
  const result = await kycService.startKycForUser('user-1');
  assert.strictEqual(result.status, 'pending');
  assert.ok(result.redirect_url);
  assert.strictEqual(result.user.kyc_status, 'pending');
});

test('assertUserKycVerified throws KYC_REQUIRED for pending users', async () => {
  const kycService = buildKycService('pending');
  await assert.rejects(
    () => kycService.assertUserKycVerified('user-1'),
    (err) => err.code === 'KYC_REQUIRED' && err.kyc_status === 'pending'
  );
});

test('assertUserKycVerified allows verified users', async () => {
  const kycService = buildKycService('verified');
  const result = await kycService.assertUserKycVerified('user-1');
  assert.strictEqual(result, null);
});
