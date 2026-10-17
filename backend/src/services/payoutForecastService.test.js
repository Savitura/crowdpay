'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222';

function buildService(queries) {
  return proxyquire('../services/payoutForecastService', {
    '../config/database': {
      query: async (text, params) => {
        for (const { match, result } of queries) {
          if (text.includes(match)) return typeof result === 'function' ? result(params) : result;
        }
        return { rows: [] };
      },
    },
    '../utils/TtlCache': {
      TtlCache: class {
        wrap(_key, fn) { return fn(); }
        invalidatePrefix() {}
      },
    },
  });
}

test('getReserveBreakdown sums fees, pending withdrawals, and scheduled payouts', async () => {
  const svc = buildService([
    { match: 'FROM campaigns', result: { rows: [{
      id: CAMPAIGN_ID, raised_amount: '1000', target_amount: '5000',
      asset_type: 'USDC', status: 'active', deadline: null,
      wallet_mode: 'standard', contract_id: null, created_at: new Date(),
    }] } },
    { match: 'SUM(platform_fee_amount)', result: { rows: [{ total_fees: '25' }] } },
    { match: 'FROM withdrawal_requests', result: { rows: [{ pending_amount: '100', pending_count: 1 }] } },
    { match: 'FROM recurring_payout_schedules', result: { rows: [{
      id: 'sched-1', amount: '50', percentage: null, asset_type: 'USDC',
      cadence: 'monthly', next_run_at: new Date(), status: 'active',
    }] } },
    { match: 'FROM treasury_policies', result: { rows: [{
      min_hold_days: 7, max_single_withdrawal_pct: 50,
      withdrawal_cooldown_hours: 24, require_auditor_for_above: '500',
    }] } },
  ]);

  const out = await svc.getReserveBreakdown(CAMPAIGN_ID);
  assert.equal(out.balance, 1000);
  assert.equal(out.reserve, 175);            // 25 + 100 + 50
  assert.equal(out.available, 825);
  assert.equal(out.breakdown.platform_fees, 25);
  assert.equal(out.breakdown.pending_withdrawals, 100);
  assert.equal(out.breakdown.scheduled_payouts, 50);
  assert.equal(out.constraints.min_hold_days, 7);
  assert.equal(out.constraints.wallet_mode, 'standard');
});

test('getReserveBreakdown caps reserve at balance when obligations exceed funds', async () => {
  const svc = buildService([
    { match: 'FROM campaigns', result: { rows: [{
      id: CAMPAIGN_ID, raised_amount: '100', target_amount: '5000',
      asset_type: 'USDC', status: 'active', deadline: null,
      wallet_mode: 'contract', contract_id: 'CABC', created_at: new Date(),
    }] } },
    { match: 'SUM(platform_fee_amount)', result: { rows: [{ total_fees: '500' }] } },
    { match: 'FROM withdrawal_requests', result: { rows: [{ pending_amount: '0', pending_count: 0 }] } },
    { match: 'FROM recurring_payout_schedules', result: { rows: [] } },
    { match: 'FROM treasury_policies', result: { rows: [] } },
  ]);

  const out = await svc.getReserveBreakdown(CAMPAIGN_ID);
  assert.equal(out.reserve, 100);
  assert.equal(out.available, 0);
  assert.equal(out.constraints.wallet_mode, 'contract');
  assert.equal(out.constraints.contract_id, 'CABC');
});

test('getReserveBreakdown uses percentage for schedules that lack a fixed amount', async () => {
  const svc = buildService([
    { match: 'FROM campaigns', result: { rows: [{
      id: CAMPAIGN_ID, raised_amount: '1000', target_amount: '5000',
      asset_type: 'USDC', status: 'active', deadline: null,
      wallet_mode: 'standard', contract_id: null, created_at: new Date(),
    }] } },
    { match: 'SUM(platform_fee_amount)', result: { rows: [{ total_fees: '0' }] } },
    { match: 'FROM withdrawal_requests', result: { rows: [{ pending_amount: '0', pending_count: 0 }] } },
    { match: 'FROM recurring_payout_schedules', result: { rows: [{
      id: 'sched-pct', amount: null, percentage: '10', asset_type: 'USDC',
      cadence: 'monthly', next_run_at: new Date(), status: 'active',
    }] } },
    { match: 'FROM treasury_policies', result: { rows: [] } },
  ]);

  const out = await svc.getReserveBreakdown(CAMPAIGN_ID);
  assert.equal(out.breakdown.scheduled_payouts, 100); // 10% of 1000
});

test('getReserveBreakdown returns null for missing or deleted campaigns', async () => {
  const svc = buildService([
    { match: 'FROM campaigns', result: { rows: [] } },
  ]);
  const out = await svc.getReserveBreakdown(CAMPAIGN_ID);
  assert.equal(out, null);
});

test('getPayoutForecast projects scheduled payouts across the horizon', async () => {
  const svc = buildService([
    { match: 'FROM campaigns', result: { rows: [{
      id: CAMPAIGN_ID, raised_amount: '1000', target_amount: '5000',
      asset_type: 'USDC', status: 'active', deadline: null,
      wallet_mode: 'standard', contract_id: null, created_at: new Date(),
    }] } },
    { match: 'SUM(platform_fee_amount)', result: { rows: [{ total_fees: '0' }] } },
    { match: 'FROM withdrawal_requests', result: { rows: [{ pending_amount: '0', pending_count: 0 }] } },
    { match: 'FROM recurring_payout_schedules', result: { rows: [{
      id: 'sched-1', amount: '100', percentage: null, asset_type: 'USDC',
      cadence: 'monthly', next_run_at: new Date(), status: 'active',
    }] } },
    { match: 'FROM treasury_policies', result: { rows: [] } },
  ]);

  const out = await svc.getPayoutForecast(CAMPAIGN_ID, { horizonMonths: 3 });
  assert.equal(out.horizon_months, 3);
  assert.equal(out.months.length, 3);
  assert.equal(out.months[0].projected_payout, 100);
  assert.equal(out.months[1].projected_payout, 100);
  assert.equal(out.months[2].projected_payout, 100);
  assert.equal(out.projected_total_payout, 300);
});

test('getPayoutForecast stops paying when projected balance hits zero', async () => {
  const svc = buildService([
    { match: 'FROM campaigns', result: { rows: [{
      id: CAMPAIGN_ID, raised_amount: '150', target_amount: '5000',
      asset_type: 'USDC', status: 'active', deadline: null,
      wallet_mode: 'standard', contract_id: null, created_at: new Date(),
    }] } },
    { match: 'SUM(platform_fee_amount)', result: { rows: [{ total_fees: '0' }] } },
    { match: 'FROM withdrawal_requests', result: { rows: [{ pending_amount: '0', pending_count: 0 }] } },
    { match: 'FROM recurring_payout_schedules', result: { rows: [{
      id: 'sched-1', amount: '100', percentage: null, asset_type: 'USDC',
      cadence: 'monthly', next_run_at: new Date(), status: 'active',
    }] } },
    { match: 'FROM treasury_policies', result: { rows: [] } },
  ]);

  const out = await svc.getPayoutForecast(CAMPAIGN_ID, { horizonMonths: 3 });
  assert.equal(out.months[0].projected_payout, 100);
  assert.equal(out.months[1].projected_payout, 50);  // balance caps
  assert.equal(out.months[2].projected_payout, 0);
  assert.equal(out.months[2].projected_balance_after, 0);
});

test('normalizeCadence returns months-per-run for supported cadences', async () => {
  const svc = buildService([]);
  assert.ok(svc.normalizeCadence('monthly') > 0);
  assert.ok(svc.normalizeCadence('WEEKLY') > 0);
  assert.equal(svc.normalizeCadence('bogus'), null);
  assert.equal(svc.normalizeCadence(null), null);
});
