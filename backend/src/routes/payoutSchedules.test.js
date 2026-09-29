process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret123456789012345678901234567890';
process.env.PLATFORM_SECRET_KEY = process.env.PLATFORM_SECRET_KEY || 'SDVGKOWW4WCVJ7GZ47S77GZGL2PZ67HQVCS475S2F3DFV2GOH63QW34Z';
process.env.PLATFORM_APPROVER_USER_ID = process.env.PLATFORM_APPROVER_USER_ID || 'platform-admin-1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const CREATOR_ID = 'creator-1';
const DESTINATION_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function buildApp({ queryImpl = async () => ({ rows: [] }), user = { userId: CREATOR_ID, role: 'creator' } } = {}) {
  const calls = [];
  const notificationsCalled = [];

  const service = proxyquire('../services/payoutScheduleService', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return queryImpl(text, params);
      },
      connect: async () => ({
        query: async (text, params) => {
          calls.push({ text, params });
          return queryImpl(text, params);
        },
        release: () => {},
      }),
    },
    './stellarService': {
      buildWithdrawalTransaction: async () => 'MOCK_XDR_STRING',
      getAccountMultisigConfig: async () => ({
        thresholds: { med_threshold: 2 },
        signers: [{ key: DESTINATION_KEY, weight: 1 }],
      }),
      getPlatformPublicKey: () => 'PLATFORM_KEY',
    },
    './stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => {},
    },
    './feeRegistry': {
      calculateCreatorShare: async () => 0,
    },
    './referral': {
      calculateCommissions: async () => ({ commissions: [] }),
    },
    './notifications': {
      createNotification: async (userId, data) => {
        notificationsCalled.push({ userId, data });
      },
    },
  });

  const router = proxyquire('./payoutSchedules', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return queryImpl(text, params);
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user;
        next();
      },
    },
    '../services/payoutScheduleService': service,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  return { app, service, calls, notificationsCalled };
}

test('POST /api/campaigns/:id/payout-schedules creates a recurring payout schedule', async () => {
  let createdSchedule = null;
  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id, creator_id, asset_type, status FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, asset_type: 'USDC', status: 'active' }] };
      }
      if (text.includes('INSERT INTO recurring_payout_schedules')) {
        createdSchedule = {
          id: 'sched-1',
          campaign_id: params[0],
          creator_id: params[1],
          amount: params[2],
          percentage: params[3],
          asset_type: params[4],
          destination_key: params[5],
          cadence: params[6],
          start_date: params[7],
          next_run_at: params[8],
          timezone: params[11],
          status: 'active',
        };
        return { rows: [createdSchedule] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post(`/api/campaigns/${CAMPAIGN_ID}/payout-schedules`)
    .send({
      amount: '500.00',
      asset_type: 'USDC',
      destination_key: DESTINATION_KEY,
      cadence: 'monthly',
      timezone: 'America/New_York',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'sched-1');
  assert.equal(res.body.cadence, 'monthly');
  assert.equal(res.body.status, 'active');
});

test('POST /api/campaigns/:id/payout-schedules/:scheduleId/pause and resume', async () => {
  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id, creator_id, asset_type, status FROM campaigns')) {
        return { rows: [{ id: CAMPAIGN_ID, creator_id: CREATOR_ID, asset_type: 'USDC', status: 'active' }] };
      }
      if (text.includes("SET status = 'paused'")) {
        return { rows: [{ id: 'sched-1', status: 'paused' }] };
      }
      if (text.includes("status = 'paused'")) {
        return {
          rows: [{
            id: 'sched-1',
            status: 'paused',
            next_run_at: new Date(Date.now() - 50000).toISOString(),
            cadence: 'weekly',
            timezone: 'UTC',
          }],
        };
      }
      if (text.includes("SET status = 'active'")) {
        return { rows: [{ id: 'sched-1', status: 'active', next_run_at: params[0] }] };
      }
      return { rows: [] };
    },
  });

  const pauseRes = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/payout-schedules/sched-1/pause`);
  assert.equal(pauseRes.status, 200);
  assert.equal(pauseRes.body.status, 'paused');

  const resumeRes = await request(app).post(`/api/campaigns/${CAMPAIGN_ID}/payout-schedules/sched-1/resume`);
  assert.equal(resumeRes.status, 200);
  assert.equal(resumeRes.body.status, 'active');
});

test('processDuePayoutSchedules raises withdrawal through two-approver flow and notifies parties', async () => {
  const dueSchedule = {
    id: 'sched-100',
    campaign_id: CAMPAIGN_ID,
    creator_id: CREATOR_ID,
    amount: '100.0000000',
    percentage: null,
    asset_type: 'USDC',
    destination_key: DESTINATION_KEY,
    cadence: 'monthly',
    start_date: new Date(Date.now() - 100000).toISOString(),
    next_run_at: new Date(Date.now() - 1000).toISOString(),
    occurrences_count: 0,
    status: 'active',
    timezone: 'UTC',
    campaign_title: 'Water Project',
    campaign_status: 'active',
    wallet_public_key: 'GCAMPAIGNKEY',
    target_amount: '10000',
    raised_amount: '5000',
    creator_email: 'creator@example.com',
    creator_name: 'Creator',
    creator_wallet_public_key: DESTINATION_KEY,
  };

  const { service, notificationsCalled } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes("status = 'active' AND s.next_run_at <= NOW()")) {
        return { rows: [dueSchedule] };
      }
      if (text.includes('COALESCE(SUM(amount), 0) AS total_withdrawn')) {
        return { rows: [{ total_withdrawn: '0' }] };
      }
      if (text.includes('COALESCE(SUM(platform_fee_amount), 0) as total_fees')) {
        return { rows: [{ total_fees: '0' }] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        return {
          rows: [{
            id: 'wr-123',
            campaign_id: CAMPAIGN_ID,
            requested_by: CREATOR_ID,
            amount: '100.0000000',
            creator_signed: false,
            platform_signed: false,
            status: 'pending',
          }],
        };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO recurring_payout_runs')) {
        return { rows: [] };
      }
      if (text.includes('UPDATE recurring_payout_schedules')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const processed = await service.processDuePayoutSchedules();
  assert.equal(processed.length, 1);
  assert.equal(processed[0].scheduleId, 'sched-100');
  assert.equal(processed[0].withdrawalRequestId, 'wr-123');
  assert.ok(notificationsCalled.length >= 2, 'Creator and platform approver should be notified');
});

test('processDuePayoutSchedules handles insufficient funds gracefully without raising withdrawal', async () => {
  const dueSchedule = {
    id: 'sched-200',
    campaign_id: CAMPAIGN_ID,
    creator_id: CREATOR_ID,
    amount: '1000.0000000',
    percentage: null,
    asset_type: 'USDC',
    destination_key: DESTINATION_KEY,
    cadence: 'monthly',
    next_run_at: new Date(Date.now() - 1000).toISOString(),
    status: 'active',
    timezone: 'UTC',
    campaign_title: 'Water Project',
    raised_amount: '500', // less than requested 1000
    creator_wallet_public_key: DESTINATION_KEY,
  };

  let runInsertedStatus = null;
  const { service, notificationsCalled } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes("status = 'active' AND s.next_run_at <= NOW()")) {
        return { rows: [dueSchedule] };
      }
      if (text.includes('COALESCE(SUM(amount), 0) AS total_withdrawn')) {
        return { rows: [{ total_withdrawn: '0' }] };
      }
      if (text.includes('INSERT INTO recurring_payout_runs')) {
        runInsertedStatus = params[2];
        return { rows: [] };
      }
      if (text.includes('UPDATE recurring_payout_schedules')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const processed = await service.processDuePayoutSchedules();
  assert.equal(processed.length, 0);
  assert.equal(runInsertedStatus, 'insufficient_funds');
  assert.ok(notificationsCalled.some((n) => n.data.type === 'payout_shortfall'));
});
