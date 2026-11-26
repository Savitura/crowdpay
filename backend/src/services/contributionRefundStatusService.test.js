'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const proxyquire = require('proxyquire').noCallThru();

function makeService({
  contribution = {},
  userWallet = 'GCONTRIBUTOR',
  refundRequest = null,
  creatorRefund = null,
  withdrawalRequest = null,
  requestEvents = [],
  campaignMembers = [],
} = {}) {
  const queryCalls = [];
  const mockDb = {
    query: async (sql, params) => {
      queryCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FROM contributions c')) {
        return {
          rows:
            contribution === null
              ? []
              : [
                  {
                    id: 'c-1',
                    campaign_id: 'camp-1',
                    sender_public_key: 'GCONTRIBUTOR',
                    amount: '100',
                    asset: 'native',
                    tx_hash: 'tx-initial',
                    refunded: false,
                    refunded_amount: '0',
                    refund_reserved_amount: '0',
                    contract_refunded_at: null,
                    contract_refund_tx_hash: null,
                    created_at: '2026-09-01T12:00:00.000Z',
                    campaign_title: 'Help the Park',
                    campaign_status: 'failed',
                    deadline: '2026-09-10T00:00:00.000Z',
                    creator_id: 'creator-1',
                    escrow_contract_id: 'C123',
                    campaign_wallet: 'GCAMPAIGN',
                    ...contribution,
                  },
                ],
        };
      }
      if (sql.includes('FROM users WHERE id')) {
        return { rows: userWallet ? [{ wallet_public_key: userWallet }] : [] };
      }
      if (sql.includes('FROM campaign_members')) {
        return { rows: campaignMembers };
      }
      if (sql.includes('FROM refund_requests')) {
        return { rows: refundRequest ? [refundRequest] : [] };
      }
      if (sql.includes('FROM creator_refunds')) {
        return { rows: creatorRefund ? [creatorRefund] : [] };
      }
      if (sql.includes('FROM withdrawal_requests')) {
        return { rows: withdrawalRequest ? [withdrawalRequest] : [] };
      }
      if (sql.includes('FROM refund_request_events')) {
        return { rows: requestEvents };
      }
      return { rows: [] };
    },
    queryCalls,
  };

  return proxyquire('./contributionRefundStatusService', {
    '../config/database': mockDb,
    '../config/stellar': {
      stellarExpertTxUrl: hash => `https://stellar.expert/explorer/testnet/tx/${hash}`,
    },
  });
}

test('calculateEstimatedCompletionTime computes correct estimates for all states', () => {
  const service = makeService();
  const now = new Date('2026-10-22T12:00:00.000Z');

  // Completed
  const completedEst = service.calculateEstimatedCompletionTime({
    status: 'completed',
    now,
  });
  assert.equal(completedEst.estimated_time_text, 'Completed');
  assert.equal(completedEst.estimated_duration_seconds, 0);
  assert.equal(completedEst.estimated_completion_at, null);

  // Blockchain processing
  const processingEst = service.calculateEstimatedCompletionTime({
    status: 'processing',
    claimedAt: '2026-10-22T12:00:00.000Z',
    now,
  });
  assert.equal(processingEst.estimated_time_text, '~5–15 minutes');
  assert.equal(processingEst.estimated_duration_seconds, 900); // 15 mins
  assert.equal(processingEst.estimated_completion_at, '2026-10-22T12:15:00.000Z');

  // Approved settlement
  const approvedEst = service.calculateEstimatedCompletionTime({
    status: 'approved',
    reviewedAt: '2026-10-22T12:00:00.000Z',
    now,
  });
  assert.equal(approvedEst.estimated_time_text, 'Within 24 hours');
  assert.equal(approvedEst.estimated_duration_seconds, 86400); // 24 hours
  assert.equal(approvedEst.estimated_completion_at, '2026-10-23T12:00:00.000Z');

  // Pending review
  const pendingEst = service.calculateEstimatedCompletionTime({
    status: 'pending',
    createdAt: '2026-10-22T12:00:00.000Z',
    now,
  });
  assert.equal(pendingEst.estimated_time_text, '2–3 business days');
  assert.equal(pendingEst.estimated_duration_seconds, 259200); // 72 hours
  assert.equal(pendingEst.estimated_completion_at, '2026-10-25T12:00:00.000Z');

  // Failed / rejected / not requested
  const rejectedEst = service.calculateEstimatedCompletionTime({ status: 'rejected', now });
  assert.equal(rejectedEst.estimated_completion_at, null);
  assert.equal(rejectedEst.estimated_time_text, null);

  const failedEst = service.calculateEstimatedCompletionTime({ status: 'failed', now });
  assert.equal(failedEst.estimated_time_text, 'Failed — action required');
});

test('getContributionRefundStatus returns eligible status for failed campaign with no refund request', async () => {
  const service = makeService();
  const res = await service.getContributionRefundStatus('c-1', 'contributor-1');

  assert.equal(res.contribution_id, 'c-1');
  assert.equal(res.refund_status, 'eligible');
  assert.equal(res.stage, 'eligible');
  assert.equal(res.remaining_refundable_amount, 100);
  assert.equal(res.estimated_time_text, 'Within 24–48 hours');
  assert.ok(res.events.length >= 2);
});

test('getContributionRefundStatus tracks pending refund request under review', async () => {
  const service = makeService({
    refundRequest: {
      id: 'req-1',
      status: 'pending',
      amount: 100,
      reason: 'Campaign did not meet goal',
      created_at: '2026-09-12T00:00:00.000Z',
    },
    requestEvents: [
      {
        id: 'ev-1',
        from_status: null,
        to_status: 'pending',
        reason: 'Campaign did not meet goal',
        created_at: '2026-09-12T00:00:00.000Z',
      },
    ],
  });

  const res = await service.getContributionRefundStatus('c-1', 'contributor-1');

  assert.equal(res.refund_status, 'pending');
  assert.equal(res.stage, 'review');
  assert.equal(res.stage_label, 'Under Review');
  assert.equal(res.estimated_time_text, '2–3 business days');
  assert.ok(res.events.some(e => e.type === 'refund_requested'));
});

test('getContributionRefundStatus tracks processing settlement', async () => {
  const service = makeService({
    refundRequest: {
      id: 'req-1',
      status: 'approved',
      amount: 100,
      reviewed_at: '2026-09-13T00:00:00.000Z',
      settlement_claimed_at: '2026-09-13T10:00:00.000Z',
    },
  });

  const res = await service.getContributionRefundStatus('c-1', 'contributor-1');

  assert.equal(res.refund_status, 'processing');
  assert.equal(res.stage, 'blockchain_processing');
  assert.equal(res.stage_label, 'Processing on Blockchain');
  assert.equal(res.estimated_time_text, '~5–15 minutes');
});

test('getContributionRefundStatus tracks completed refund on Stellar ledger', async () => {
  const service = makeService({
    contribution: {
      refunded: true,
      refunded_amount: '100',
      contract_refunded_at: '2026-09-14T10:00:00.000Z',
      contract_refund_tx_hash: 'tx-stellar-refund-12345678',
    },
  });

  const res = await service.getContributionRefundStatus('c-1', 'contributor-1');

  assert.equal(res.refund_status, 'completed');
  assert.equal(res.stage, 'settled');
  assert.equal(res.estimated_time_text, 'Completed');
  assert.equal(res.tx_hash, 'tx-stellar-refund-12345678');
  assert.equal(
    res.stellar_tx_url,
    'https://stellar.expert/explorer/testnet/tx/tx-stellar-refund-12345678'
  );
  assert.ok(res.events.some(e => e.type === 'refund_settled'));
});

test('getContributionRefundStatus rejects unauthorized viewer with 403', async () => {
  const service = makeService({ userWallet: 'GSTRANGER' });
  await assert.rejects(
    () => service.getContributionRefundStatus('c-1', 'stranger-user-id'),
    err => {
      assert.equal(err.status, 403);
      assert.match(err.message, /not authorized/i);
      return true;
    }
  );
});

test('getContributionRefundStatus allows admin to view any contribution', async () => {
  const service = makeService({ userWallet: 'GADMIN' });
  const res = await service.getContributionRefundStatus('c-1', 'admin-id', { isAdmin: true });
  assert.equal(res.contribution_id, 'c-1');
});

test('getContributionRefundStatus throws 404 for nonexistent contribution', async () => {
  const service = makeService({ contribution: null });
  await assert.rejects(
    () => service.getContributionRefundStatus('nonexistent', 'user-1'),
    err => {
      assert.equal(err.status, 404);
      assert.match(err.message, /not found/i);
      return true;
    }
  );
});
