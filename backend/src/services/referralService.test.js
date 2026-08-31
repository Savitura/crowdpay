const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('adjustReferralCommissionOnRefund correctly adjusts commission on partial refund', async () => {
  const queries = [];
  const dbStub = {
    connect: async () => ({
      query: async (text, params) => {
        queries.push({ text, params });
        if (text.includes('FROM contributions')) {
          return { rows: [{ id: 'c-1', campaign_id: 'camp-1', amount: '100.0000000', referral_link_id: 'link-1' }] };
        }
        if (text.includes('FROM referral_links')) {
          return { rows: [{ id: 'link-1', user_id: 'user-ref', campaign_id: 'camp-1' }] };
        }
        if (text.includes('FROM referral_programs')) {
          return { rows: [{ commission_percentage: '5.00' }] };
        }
        if (text.includes('FROM referral_commissions')) {
          return { rows: [{ id: 'comm-1', commission_amount: '5.0000000', status: 'credited' }] };
        }
        return { rows: [] };
      },
      release: async () => {},
    }),
  };

  const referralService = proxyquire('./referralService', {
    '../config/database': dbStub,
    '../config/logger': { info: () => {}, error: () => {} },
  });

  await referralService.adjustReferralCommissionOnRefund({
    contributionId: 'c-1',
    refundAmount: '50.0000000',
  });

  const updateQuery = queries.find((q) => q.text.includes('UPDATE referral_commissions'));
  assert.ok(updateQuery);
  assert.equal(updateQuery.params[0], '2.5000000');

  const adjQuery = queries.find((q) => q.text.includes('INSERT INTO referral_commission_adjustments'));
  assert.ok(adjQuery);
  assert.equal(adjQuery.params[2], '-2.5000000');
});