'use strict';

const db = require('../config/database');
const { TtlCache } = require('../utils/TtlCache');

const forecastCache = new TtlCache(5 * 60_000); // 5 minutes

const CADENCE_MONTHS = {
  weekly: 1 / 4.345,
  biweekly: 2 / 4.345,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function normalizeCadence(cadence) {
  if (!cadence) return null;
  const key = String(cadence).toLowerCase();
  return CADENCE_MONTHS[key] ?? null;
}

async function getReserveBreakdown(campaignId) {
  const [campaign, fees, pendingWithdrawals, schedules, policy] = await Promise.all([
    db.query(
      `SELECT id, raised_amount, target_amount, asset_type, status, deadline,
              wallet_mode, contract_id, created_at
         FROM campaigns
        WHERE id = $1 AND deleted_at IS NULL`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(SUM(platform_fee_amount), 0) AS total_fees
         FROM contributions
        WHERE campaign_id = $1 AND refunded = FALSE`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(SUM(amount), 0) AS pending_amount,
              COUNT(*)::int          AS pending_count
         FROM withdrawal_requests
        WHERE campaign_id = $1
          AND status IN ('pending', 'submitted', 'pending_creator', 'pending_auditor')`,
      [campaignId]
    ),
    db.query(
      `SELECT id, amount, percentage, asset_type, cadence, next_run_at, status
         FROM recurring_payout_schedules
        WHERE campaign_id = $1 AND status = 'active'
        ORDER BY next_run_at ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT min_hold_days, max_single_withdrawal_pct,
              withdrawal_cooldown_hours, require_auditor_for_above
         FROM treasury_policies
        WHERE campaign_id = $1`,
      [campaignId]
    ),
  ]);

  if (!campaign.rows.length) return null;
  const c = campaign.rows[0];

  const raised = Number(c.raised_amount) || 0;
  const totalFees = Number(fees.rows[0].total_fees) || 0;
  const pendingAmount = Number(pendingWithdrawals.rows[0].pending_amount) || 0;
  const p = policy.rows[0] || null;

  let scheduledReserve = 0;
  const scheduleLines = schedules.rows.map(s => {
    let nextAmount = 0;
    if (s.amount !== null && s.amount !== undefined) {
      nextAmount = Number(s.amount);
    } else if (s.percentage !== null && s.percentage !== undefined) {
      nextAmount = (raised * Number(s.percentage)) / 100;
    }
    scheduledReserve += nextAmount;
    return {
      schedule_id: s.id,
      cadence: s.cadence,
      next_run_at: s.next_run_at,
      next_amount: Number(nextAmount.toFixed(7)),
    };
  });

  const rawReserve = totalFees + pendingAmount + scheduledReserve;
  const reserve = Math.min(rawReserve, raised);

  const constraints = {
    min_hold_days: p?.min_hold_days ?? 0,
    max_single_withdrawal_pct: p?.max_single_withdrawal_pct ?? 100,
    withdrawal_cooldown_hours: p?.withdrawal_cooldown_hours ?? 0,
    require_auditor_for_above: p ? Number(p.require_auditor_for_above) : 0,
    wallet_mode: c.wallet_mode || 'standard',
    contract_id: c.contract_id || null,
  };

  return {
    campaign_id: c.id,
    asset_type: c.asset_type,
    status: c.status,
    deadline: c.deadline,
    balance: Number(raised.toFixed(7)),
    reserve: Number(reserve.toFixed(7)),
    available: Number(Math.max(0, raised - reserve).toFixed(7)),
    breakdown: {
      platform_fees: Number(totalFees.toFixed(7)),
      pending_withdrawals: Number(pendingAmount.toFixed(7)),
      scheduled_payouts: Number(scheduledReserve.toFixed(7)),
      unallocated_reserve: Number(Math.max(0, reserve - rawReserve).toFixed(7)),
    },
    scheduled_payouts: scheduleLines,
    constraints,
    generated_at: new Date().toISOString(),
  };
}

async function getPayoutForecast(campaignId, { horizonMonths = 6 } = {}) {
  const cacheKey = `forecast:${campaignId}:${horizonMonths}`;
  return forecastCache.wrap(cacheKey, async () => {
    const breakdown = await getReserveBreakdown(campaignId);
    if (!breakdown) return null;

    const schedules = breakdown.scheduled_payouts
      .map(s => ({ ...s, months: normalizeCadence(s.cadence) }))
      .filter(s => s.months !== null && s.next_amount > 0);

    let balance = breakdown.balance;
    const months = [];

    for (let i = 0; i < horizonMonths; i++) {
      const monthStart = new Date();
      monthStart.setUTCMonth(monthStart.getUTCMonth() + i, 1);
      monthStart.setUTCHours(0, 0, 0, 0);

      const monthEnd = new Date(monthStart);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

      let scheduledThisMonth = 0;
      const payouts = [];

      for (const s of schedules) {
        const everyNMonths = Math.max(1, Math.round(1 / s.months));
        if (i % everyNMonths !== 0) continue;

        let amount = s.next_amount;
        if (amount > balance) amount = balance;
        if (amount <= 0) continue;

        scheduledThisMonth += amount;
        balance -= amount;
        payouts.push({
          schedule_id: s.schedule_id,
          amount: Number(amount.toFixed(7)),
        });
      }

      months.push({
        month: monthStart.toISOString().slice(0, 7),
        projected_payout: Number(scheduledThisMonth.toFixed(7)),
        projected_balance_after: Number(Math.max(0, balance).toFixed(7)),
        payouts,
      });
    }

    const totalForecast = months.reduce((sum, m) => sum + m.projected_payout, 0);

    return {
      campaign_id: breakdown.campaign_id,
      asset_type: breakdown.asset_type,
      horizon_months: horizonMonths,
      opening_balance: breakdown.balance,
      reserve_today: breakdown.reserve,
      available_today: breakdown.available,
      projected_total_payout: Number(totalForecast.toFixed(7)),
      months,
      reserve_breakdown: breakdown.breakdown,
      constraints: breakdown.constraints,
      generated_at: new Date().toISOString(),
    };
  });
}

module.exports = {
  getReserveBreakdown,
  getPayoutForecast,
  normalizeCadence,
  CADENCE_MONTHS,
};
