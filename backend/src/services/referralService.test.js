const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildReferralService(queryImpl) {
  return proxyquire('./referralService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { warn: () => {} },
  });
}

test('getReferralCodeFromRequest reads referral cookie', () => {
  const { getReferralCodeFromRequest } = buildReferralService(async () => ({ rows: [] }));
  const req = { cookies: { 'cp_ref_camp-1': 'abc12345' } };
  assert.equal(getReferralCodeFromRequest('camp-1', req), 'abc12345');
  assert.equal(getReferralCodeFromRequest('camp-1', { cookies: {} }), null);
});

test('attributeContributionToReferrer increments contribution_count', async () => {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT id FROM campaign_referrals')) {
      return { rows: [{ id: 'ref-1' }] };
    }
    return { rows: [] };
  };

  const { attributeContributionToReferrer } = buildReferralService(queryImpl);
  await attributeContributionToReferrer('camp-1', 'abc12345');

  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /SELECT id FROM campaign_referrals/);
  assert.deepEqual(calls[0].params, ['abc12345', 'camp-1']);
  assert.match(calls[1].text, /contribution_count = contribution_count \+ 1/);
  assert.deepEqual(calls[1].params, ['ref-1']);
});

test('attributeContributionToReferrer no-ops when referral code is missing', async () => {
  const calls = [];
  const { attributeContributionToReferrer } = buildReferralService(async (...args) => {
    calls.push(args);
    return { rows: [] };
  });

  await attributeContributionToReferrer('camp-1', null);
  await attributeContributionToReferrer('camp-1', '');
  assert.equal(calls.length, 0);
});

test('attributeContributionToReferrer no-ops when referral row is not found', async () => {
  const calls = [];
  const { attributeContributionToReferrer } = buildReferralService(async (text) => {
    calls.push(text);
    return { rows: [] };
  });

  await attributeContributionToReferrer('camp-1', 'missing-code');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /SELECT id FROM campaign_referrals/);
});
