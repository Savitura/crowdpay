/**
 * Exact-stroop payout math for recurring payout schedules (#1196).
 */
process.env.NODE_ENV = 'test';
process.env.PLATFORM_SECRET_KEY =
  process.env.PLATFORM_SECRET_KEY || 'SDVGKOWW4WCVJ7GZ47S77GZGL2PZ67HQVCS475S2F3DFV2GOH63QW34Z';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { toStroops } = require('../utils/stroops');

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const DESTINATION_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const REFERRER_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function loadService({ queryImpl, commissions = [], built = [] } = {}) {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    return queryImpl ? queryImpl(text, params) : { rows: [] };
  };
  const service = proxyquire('./payoutScheduleService', {
    '../config/database': {
      query,
      connect: async () => ({
        query: async (text, params) => {
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          return query(text, params);
        },
        release: () => {},
      }),
    },
    './stellarService': {
      buildWithdrawalTransaction: async params => {
        built.push(params);
        return 'MOCK_XDR';
      },
    },
    './stellarTransactionService': { insertWithdrawalPendingSignatures: async () => {} },
    './referral': { calculateCommissions: async () => ({ commissions }) },
    './notifications': { createNotification: async () => {} },
  });
  return { service, calls };
}

const { service: pure } = loadService();
const { computeScheduledPayoutStroops, splitPayoutCommissions } = pure;

test('fixed-amount schedules pay the stored amount exactly', () => {
  assert.equal(computeScheduledPayoutStroops({ amount: '8.2900000' }), 82_900_000n);
  assert.equal(computeScheduledPayoutStroops({ amount: '0.0000001' }), 1n);
  // Beyond 2^53 stroops: parseFloat would lose the trailing stroop.
  assert.equal(
    computeScheduledPayoutStroops({ amount: '922337203685.4775807' }),
    9_223_372_036_854_775_807n
  );
});

test('percentage schedules use integer basis points and floor to the stroop', () => {
  // 33.33% of 10.0000001 = 3.33300003333 -> 3.3330000 (never rounds up)
  assert.equal(
    computeScheduledPayoutStroops({ percentage: '33.33', raised_amount: '10.0000001' }),
    33_330_000n
  );
  // 0.29% in floats is 0.0029 * 100 -> drift; bps math is exact: 29 bps of 100 = 0.29
  assert.equal(
    computeScheduledPayoutStroops({ percentage: '0.29', raised_amount: '100' }),
    2_900_000n
  );
  // A share smaller than one stroop pays nothing rather than rounding up.
  assert.equal(
    computeScheduledPayoutStroops({ percentage: '0.01', raised_amount: '0.0000099' }),
    0n
  );
  assert.equal(
    computeScheduledPayoutStroops({ percentage: '100.00', raised_amount: '5000.1234567' }),
    toStroops('5000.1234567')
  );
  assert.equal(computeScheduledPayoutStroops({ percentage: '10', raised_amount: null }), 0n);
  assert.equal(computeScheduledPayoutStroops({}), 0n);
});

test('percentage schedules reject sub-basis-point percentages instead of rounding', () => {
  assert.throws(
    () => computeScheduledPayoutStroops({ percentage: '12.345', raised_amount: '100' }),
    /basis point/
  );
});

test('commissions are summed exactly and the creator gets the exact remainder', () => {
  const { payableCommissions, commissionStroops, creatorStroops } = splitPayoutCommissions(
    toStroops('1'),
    [
      // 0.1 + 0.2 = 0.30000000000000004 in floats
      { destination_public_key: REFERRER_KEY, commission_owed: '0.1000000' },
      { destination_public_key: REFERRER_KEY, commission_owed: '0.2' },
      { destination_public_key: null, commission_owed: '5' },
      { destination_public_key: REFERRER_KEY, commission_owed: '0.0000000' },
      { destination_public_key: REFERRER_KEY },
    ]
  );
  assert.equal(payableCommissions.length, 2);
  assert.deepEqual(
    payableCommissions.map(c => c.commission_owed),
    ['0.1000000', '0.2000000']
  );
  assert.equal(commissionStroops, 3_000_000n);
  assert.equal(creatorStroops, 7_000_000n);
  assert.equal(creatorStroops + commissionStroops, toStroops('1'));
});

test('a single-stroop commission is kept, not filtered as float noise', () => {
  const { payableCommissions, creatorStroops } = splitPayoutCommissions(10n, [
    { destination_public_key: REFERRER_KEY, commission_owed: '0.0000001' },
  ]);
  assert.equal(payableCommissions.length, 1);
  assert.equal(creatorStroops, 9n);
});

function dueSchedule(overrides) {
  return {
    id: 'sched-1',
    campaign_id: CAMPAIGN_ID,
    creator_id: 'creator-1',
    amount: null,
    percentage: null,
    asset_type: 'USDC',
    destination_key: DESTINATION_KEY,
    cadence: 'monthly',
    next_run_at: new Date(Date.now() - 1000).toISOString(),
    status: 'active',
    timezone: 'UTC',
    campaign_title: 'Water Project',
    wallet_public_key: 'GCAMPAIGNKEY',
    creator_wallet_public_key: DESTINATION_KEY,
    ...overrides,
  };
}

function scheduleQueries(schedule, totalWithdrawn) {
  const state = { runStatus: null, withdrawalAmount: null, shortfallMessage: null };
  const queryImpl = async (text, params) => {
    if (text.includes("status = 'active' AND s.next_run_at <= NOW()")) {
      return { rows: [schedule] };
    }
    if (text.includes('AS total_withdrawn')) {
      return { rows: [{ total_withdrawn: totalWithdrawn }] };
    }
    if (text.includes('INSERT INTO recurring_payout_runs')) {
      state.runStatus = params[2];
      if (params[2] === 'insufficient_funds') state.shortfallMessage = params[4];
      return { rows: [] };
    }
    if (text.includes('INSERT INTO withdrawal_requests')) {
      state.withdrawalAmount = params[2];
      return { rows: [{ id: 'wr-1', amount: params[2] }] };
    }
    return { rows: [] };
  };
  return { state, queryImpl };
}

test('available funds are compared exactly: 0.3 raised - 0.1 withdrawn covers a 0.2 payout', async () => {
  // In floats 0.3 - 0.1 = 0.19999999999999998 < 0.2, which used to record a
  // spurious shortfall.
  const { state, queryImpl } = scheduleQueries(
    dueSchedule({ amount: '0.2000000', raised_amount: '0.3000000' }),
    '0.1000000'
  );
  const built = [];
  const { service } = loadService({ queryImpl, built });

  const processed = await service.processDuePayoutSchedules();

  assert.equal(processed.length, 1);
  assert.equal(state.withdrawalAmount, '0.2000000');
  assert.equal(built[0].amount, '0.2000000');
});

test('a payout one stroop above available funds records a shortfall', async () => {
  const { state, queryImpl } = scheduleQueries(
    dueSchedule({ amount: '50.0000001', raised_amount: '100' }),
    '50'
  );
  const { service } = loadService({ queryImpl });

  const processed = await service.processDuePayoutSchedules();

  assert.equal(processed.length, 0);
  assert.equal(state.runStatus, 'insufficient_funds');
  assert.match(state.shortfallMessage, /requested 50\.0000001 USDC, available 50\.0000000 USDC/);
});

test('percentage payouts pass exact creator and commission amounts to the transaction', async () => {
  const { state, queryImpl } = scheduleQueries(
    dueSchedule({ percentage: '33.33', raised_amount: '10.0000001' }),
    '0'
  );
  const built = [];
  const { service } = loadService({
    queryImpl,
    built,
    commissions: [{ destination_public_key: REFERRER_KEY, commission_owed: '0.0000001' }],
  });

  await service.processDuePayoutSchedules();

  assert.equal(state.withdrawalAmount, '3.3330000');
  assert.equal(built[0].amount, '3.3329999');
  assert.deepEqual(built[0].commissions, [
    { destinationPublicKey: REFERRER_KEY, amount: '0.0000001' },
  ]);
});

test('calculateNextRunTime advances by cadence', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(pure.calculateNextRunTime(base, 'daily').toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal(pure.calculateNextRunTime(base, 'weekly').toISOString(), '2026-01-08T00:00:00.000Z');
  assert.equal(
    pure.calculateNextRunTime(base, 'biweekly').toISOString(),
    '2026-01-15T00:00:00.000Z'
  );
  assert.equal(
    pure.calculateNextRunTime(base, 'monthly').toISOString(),
    '2026-02-01T00:00:00.000Z'
  );
  assert.equal(
    pure.calculateNextRunTime(base, 'unknown').toISOString(),
    '2026-02-01T00:00:00.000Z'
  );
});

test('createPayoutSchedule validates inputs and inserts active schedule', async () => {
  const { service } = loadService({
    queryImpl: async (text, params) => {
      if (text.includes('INSERT INTO recurring_payout_schedules')) {
        return {
          rows: [{ id: 'sched-new', amount: params[2], cadence: params[6], status: 'active' }],
        };
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        amount: '10',
        assetType: 'USDC',
        destinationKey: DESTINATION_KEY,
        cadence: 'hourly',
      }),
    err => err.statusCode === 422 && /Invalid cadence/.test(err.message)
  );

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        assetType: 'USDC',
        destinationKey: DESTINATION_KEY,
        cadence: 'weekly',
      }),
    err => err.statusCode === 422 && /amount or percentage/.test(err.message)
  );

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        amount: '0',
        assetType: 'USDC',
        destinationKey: DESTINATION_KEY,
        cadence: 'weekly',
      }),
    err => err.statusCode === 422 && /greater than 0/.test(err.message)
  );

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        percentage: '12.345',
        assetType: 'USDC',
        destinationKey: DESTINATION_KEY,
        cadence: 'weekly',
      }),
    err => err.statusCode === 422 && /Percentage/.test(err.message)
  );

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        amount: '10',
        assetType: 'USDC',
        destinationKey: 'INVALID_KEY',
        cadence: 'weekly',
      }),
    err => err.statusCode === 422 && /Stellar destination/.test(err.message)
  );

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        amount: '10',
        assetType: 'USDC',
        destinationKey: DESTINATION_KEY,
        cadence: 'weekly',
        startDate: 'not-a-date',
      }),
    err => err.statusCode === 422 && /Invalid start_date/.test(err.message)
  );

  await assert.rejects(
    () =>
      service.createPayoutSchedule({
        campaignId: CAMPAIGN_ID,
        creatorId: 'creator-1',
        amount: '10',
        assetType: 'USDC',
        destinationKey: DESTINATION_KEY,
        cadence: 'weekly',
        startDate: '2026-05-10T00:00:00Z',
        endDate: '2026-05-01T00:00:00Z',
      }),
    err => err.statusCode === 422 && /end_date must be after start_date/.test(err.message)
  );

  const created = await service.createPayoutSchedule({
    campaignId: CAMPAIGN_ID,
    creatorId: 'creator-1',
    amount: '25.5',
    assetType: 'USDC',
    destinationKey: DESTINATION_KEY,
    cadence: 'weekly',
  });
  assert.equal(created.id, 'sched-new');
  assert.equal(created.amount, '25.5000000');
  assert.equal(created.status, 'active');
});

test('listPayoutSchedules, getPayoutSchedule, pause, resume, and cancel lifecycle', async () => {
  const pastRun = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  let resumedNextRun = null;

  const { service } = loadService({
    queryImpl: async (text, params) => {
      if (text.includes('ORDER BY created_at DESC')) {
        return { rows: [{ id: 'sched-1' }] };
      }
      if (
        text.includes('FROM recurring_payout_schedules') &&
        text.includes('WHERE id = $1 AND campaign_id = $2 AND creator_id = $3') &&
        !text.includes('paused')
      ) {
        if (params[0] === 'missing') return { rows: [] };
        return { rows: [{ id: params[0], status: 'active' }] };
      }
      if (text.includes('FROM recurring_payout_runs')) {
        return { rows: [{ id: 'run-1', status: 'success' }] };
      }
      if (text.includes("SET status = 'paused'")) {
        if (params[0] === 'missing') return { rows: [] };
        return { rows: [{ id: params[0], status: 'paused' }] };
      }
      if (text.includes("status = 'paused'")) {
        if (params[0] === 'missing') return { rows: [] };
        return {
          rows: [
            {
              id: params[0],
              status: 'paused',
              cadence: 'weekly',
              next_run_at: pastRun,
              timezone: 'UTC',
            },
          ],
        };
      }
      if (text.includes("SET status = 'active', next_run_at = $1")) {
        resumedNextRun = params[0];
        return { rows: [{ id: params[1], status: 'active', next_run_at: params[0] }] };
      }
      if (text.includes("SET status = 'cancelled'")) {
        if (params[0] === 'missing') return { rows: [] };
        return { rows: [{ id: params[0], status: 'cancelled' }] };
      }
      return { rows: [] };
    },
  });

  const list = await service.listPayoutSchedules(CAMPAIGN_ID, 'creator-1');
  assert.equal(list.length, 1);

  const detail = await service.getPayoutSchedule('sched-1', CAMPAIGN_ID, 'creator-1');
  assert.equal(detail.runs.length, 1);
  await assert.rejects(
    () => service.getPayoutSchedule('missing', CAMPAIGN_ID, 'creator-1'),
    err => err.statusCode === 404
  );

  const paused = await service.pausePayoutSchedule('sched-1', CAMPAIGN_ID, 'creator-1');
  assert.equal(paused.status, 'paused');
  await assert.rejects(
    () => service.pausePayoutSchedule('missing', CAMPAIGN_ID, 'creator-1'),
    err => err.statusCode === 404
  );

  const resumed = await service.resumePayoutSchedule('sched-1', CAMPAIGN_ID, 'creator-1');
  assert.equal(resumed.status, 'active');
  assert.ok(new Date(resumedNextRun) > new Date());
  await assert.rejects(
    () => service.resumePayoutSchedule('missing', CAMPAIGN_ID, 'creator-1'),
    err => err.statusCode === 404
  );

  const cancelled = await service.cancelPayoutSchedule('sched-1', CAMPAIGN_ID, 'creator-1');
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(
    () => service.cancelPayoutSchedule('missing', CAMPAIGN_ID, 'creator-1'),
    err => err.statusCode === 404
  );
});

test('processDuePayoutSchedules returns [] when advisory lock is not acquired', async () => {
  const service = proxyquire('./payoutScheduleService', {
    '../config/database': {
      query: async () => {
        throw new Error('should not query schedules');
      },
      connect: async () => ({
        query: async () => ({ rows: [{ locked: false }] }),
        release: () => {},
      }),
    },
    './stellarService': { buildWithdrawalTransaction: async () => 'XDR' },
    './stellarTransactionService': { insertWithdrawalPendingSignatures: async () => {} },
    './referral': { calculateCommissions: async () => ({ commissions: [] }) },
    './notifications': { createNotification: async () => {} },
  });

  const processed = await service.processDuePayoutSchedules();
  assert.deepEqual(processed, []);
});

test('processDuePayoutSchedules is idempotent when idempotency_key already exists and marks completed at max_occurrences', async () => {
  let withdrawalInsertCount = 0;
  let updatedStatus = null;
  let updatedOccurrences = null;

  const schedule = dueSchedule({
    amount: '10.0000000',
    raised_amount: '100.0000000',
    occurrences_count: 2,
    max_occurrences: 3,
  });

  const { service } = loadService({
    queryImpl: async (text, params) => {
      if (text.includes("status = 'active' AND s.next_run_at <= NOW()"))
        return { rows: [schedule] };
      if (text.includes('AS total_withdrawn')) return { rows: [{ total_withdrawn: '0' }] };
      if (text.includes('WHERE idempotency_key = $1')) {
        return { rows: [{ withdrawal_request_id: 'wr-existing' }] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        withdrawalInsertCount++;
        return { rows: [{ id: 'wr-new' }] };
      }
      if (
        text.includes('UPDATE recurring_payout_schedules') &&
        text.includes('occurrences_count')
      ) {
        updatedOccurrences = params[0];
        updatedStatus = params[3];
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const processed = await service.processDuePayoutSchedules();
  assert.equal(processed.length, 1);
  assert.equal(processed[0].withdrawalRequestId, 'wr-existing');
  assert.equal(withdrawalInsertCount, 0);
  assert.equal(updatedOccurrences, 3);
  assert.equal(updatedStatus, 'completed');
});

test('processDuePayoutSchedules falls back to mock XDR on build failure and records last_error on tx failure', async () => {
  const insertedXdrs = [];
  let recordedError = null;
  let rolledBack = false;

  const schedOk = dueSchedule({
    id: 'sched-ok',
    amount: '5.0000000',
    raised_amount: '100.0000000',
  });
  const schedFail = dueSchedule({
    id: 'sched-fail',
    amount: '5.0000000',
    raised_amount: '100.0000000',
  });

  const service = proxyquire('./payoutScheduleService', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes("status = 'active' AND s.next_run_at <= NOW()")) {
          return { rows: [schedOk, schedFail] };
        }
        if (text.includes('AS total_withdrawn')) return { rows: [{ total_withdrawn: '0' }] };
        if (text.includes('SET last_error = $1')) {
          recordedError = params;
          return { rows: [] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (text, params) => {
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          if (text === 'ROLLBACK') {
            rolledBack = true;
            return { rows: [] };
          }
          if (text.includes('INSERT INTO withdrawal_requests')) {
            if (params[5].includes('sched-fail')) {
              throw new Error('db insert boom');
            }
            insertedXdrs.push(params[4]);
            return { rows: [{ id: 'wr-ok' }] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    './stellarService': {
      buildWithdrawalTransaction: async () => {
        throw new Error('horizon down');
      },
    },
    './stellarTransactionService': { insertWithdrawalPendingSignatures: async () => {} },
    './referral': { calculateCommissions: async () => ({ commissions: [] }) },
    './notifications': { createNotification: async () => {} },
  });

  const processed = await service.processDuePayoutSchedules();
  assert.equal(processed.length, 1);
  assert.equal(insertedXdrs[0], 'MOCK_AUTOMATED_SCHEDULED_XDR_sched-ok');
  assert.equal(rolledBack, true);
  assert.deepEqual(recordedError, ['db insert boom', 'sched-fail']);
});
