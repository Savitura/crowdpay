const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildActions(overrides = {}) {
  const calls = {
    emails: [],
    userWebhooks: [],
    campaignWebhooks: [],
    notifications: [],
    refunds: [],
    statusEvents: [],
  };

  const actions = proxyquire('./campaignStatusActions', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('INSERT INTO campaign_status_events')) {
          const key = `${params[0]}:${params[2]}`;
          if (calls.statusEvents.includes(key)) {
            return { rows: [] };
          }
          calls.statusEvents.push(key);
          return { rows: [{ id: 'event-1' }] };
        }
        if (text.includes('FROM campaigns c') && text.includes('creator_email')) {
          return {
            rows: [{
              id: params[0],
              title: 'Test Campaign',
              status: 'funded',
              target_amount: '100',
              raised_amount: '100',
              deadline: '2026-06-01',
              wallet_public_key: 'GPK',
              escrow_contract_id: null,
              creator_id: 'creator-1',
              creator_email: 'creator@test.com',
              creator_name: 'Creator',
            }],
          };
        }
        if (text.includes('FROM contributions c') && text.includes('JOIN users u')) {
          return {
            rows: [{ id: 'contrib-user-1', email: 'backer@test.com', name: 'Backer' }],
          };
        }
        if (text.includes('SELECT id, wallet_public_key, status, creator_id FROM campaigns')) {
          return { rows: [{ id: params[0], wallet_public_key: 'GPK', status: 'failed', creator_id: 'creator-1' }] };
        }
        if (text.includes('FROM contributions c') && text.includes('withdrawal_requests')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      ...(overrides.db || {}),
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './emailService': {
      sendCampaignFundedCreatorEmail: async (payload) => {
        calls.emails.push({ to: payload.to, text: `Congratulations campaign ${payload.campaignTitle}` });
      },
      sendCampaignFundedContributorEmail: async (payload) => {
        calls.emails.push({ to: payload.to, text: `Campaign ${payload.campaignTitle} funded` });
      },
      sendCampaignFailedCreatorEmail: async (payload) => {
        calls.emails.push({ to: payload.to, text: `Campaign ${payload.campaignTitle} ended below goal` });
      },
      sendCampaignFailedContributorEmail: async (payload) => {
        calls.emails.push({ to: payload.to, text: `refund available ${payload.refundsUrl}` });
      },
    },
    './notifications': {
      createNotification: async (userId, payload) => {
        calls.notifications.push({ userId, ...payload });
      },
    },
    './webhookDispatcher': {
      WEBHOOK_EVENTS: {
        CAMPAIGN_FUNDED: 'campaign.funded',
        CAMPAIGN_FAILED: 'campaign.failed',
      },
      emitWebhookEventForUser: async (userId, event, payload) => {
        calls.userWebhooks.push({ userId, event, payload });
      },
      emitWebhookEventForCampaign: async (campaignId, event, payload) => {
        calls.campaignWebhooks.push({ campaignId, event, payload });
      },
    },
    './stellarService': {
      buildWithdrawalTransaction: async () => 'unsigned-xdr',
    },
    './stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => 'tx-row',
    },
    './sorobanService': {
      invokeContract: async () => 0,
    },
    ...overrides.modules,
  });

  return { actions, calls };
}

test('triggerCampaignStatusActions sends funded lifecycle notifications once', async () => {
  const { actions, calls } = buildActions();

  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');
  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');

  assert.equal(calls.statusEvents.length, 1);
  assert.equal(calls.emails.length, 2);
  assert.ok(calls.emails.some((e) => e.to === 'creator@test.com'));
  assert.ok(calls.emails.some((e) => e.to === 'backer@test.com'));
  assert.equal(calls.userWebhooks.length, 1);
  assert.equal(calls.campaignWebhooks.length, 1);
  assert.equal(calls.notifications.length, 2);
});

test('triggerCampaignStatusActions sends failed emails with refund instructions', async () => {
  const { actions, calls } = buildActions({
    db: {
      query: async (text, params) => {
        if (text.includes('INSERT INTO campaign_status_events')) {
          return { rows: [{ id: 'event-failed' }] };
        }
        if (text.includes('FROM campaigns c') && text.includes('creator_email')) {
          return {
            rows: [{
              id: params[0],
              title: 'Missed Goal',
              status: 'failed',
              target_amount: '100',
              raised_amount: '40',
              deadline: '2026-06-01',
              wallet_public_key: 'GPK',
              escrow_contract_id: null,
              creator_id: 'creator-1',
              creator_email: 'creator@test.com',
              creator_name: 'Creator',
            }],
          };
        }
        if (text.includes('JOIN users u')) {
          return { rows: [{ id: 'contrib-user-1', email: 'backer@test.com', name: 'Backer' }] };
        }
        if (text.includes('SELECT id, wallet_public_key, status, creator_id FROM campaigns')) {
          return { rows: [{ id: params[0], wallet_public_key: 'GPK', status: 'failed', creator_id: 'creator-1' }] };
        }
        if (text.includes('FROM contributions c') && text.includes('withdrawal_requests')) {
          return {
            rows: [{
              id: 'contrib-1',
              sender_public_key: 'GSENDER',
              amount: '10',
              asset: 'USDC',
            }],
          };
        }
        if (text.includes('INSERT INTO withdrawal_requests')) {
          return { rows: [{ id: 'wr-1' }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (text) => {
          if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
          if (text.includes('INSERT INTO withdrawal_requests')) return { rows: [{ id: 'wr-1' }] };
          if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
          return { rows: [] };
        },
        release: () => {},
      }),
    },
  });

  await actions.triggerCampaignStatusActions({ id: 'camp-2', status: 'failed' }, 'active');

  const backerEmail = calls.emails.find((e) => e.to === 'backer@test.com');
  assert.ok(backerEmail);
  assert.match(backerEmail.text, /refund/i);
  assert.match(backerEmail.text, /refund=1/);
  assert.equal(calls.userWebhooks[0].event, 'campaign.failed');
  assert.equal(calls.campaignWebhooks[0].event, 'campaign.failed');
});

test('recordStatusTransition is idempotent via unique constraint', async () => {
  const { actions, calls } = buildActions();

  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');
  await actions.triggerCampaignStatusActions({ id: 'camp-1', status: 'funded' }, 'active');

  assert.equal(calls.emails.length, 2);
});

test('queueFailedCampaignRefunds automatically executes contract refunds, retries on failure, updates DB, and sends emails', async () => {
  const refundCalls = [];
  const dbQueries = [];
  const sentEmails = [];

  const mockSorobanService = {
    refund: async (contractId, contributorPublicKey) => {
      refundCalls.push({ contractId, contributorPublicKey });
      if (contributorPublicKey === 'fail-key') {
        throw new Error('Soroban error');
      }
    }
  };

  const mockDb = {
    query: async (text, params) => {
      dbQueries.push({ text, params });
      if (text.includes('SELECT id, wallet_public_key, status, creator_id, escrow_contract_id, title FROM campaigns')) {
        return {
          rows: [{
            id: 'failed-campaign-id',
            wallet_public_key: 'GPK',
            status: 'failed',
            creator_id: 'creator-1',
            escrow_contract_id: 'escrow-123',
            title: 'Failed Campaign'
          }]
        };
      }
      if (text.includes('FROM contributions WHERE campaign_id = $1 AND refunded = FALSE')) {
        return {
          rows: [
            { id: 'contrib-1', sender_public_key: 'user-key-1', amount: '10.0', asset: 'USDC' },
            { id: 'contrib-2', sender_public_key: 'fail-key', amount: '5.0', asset: 'XLM' }
          ]
        };
      }
      if (text.includes('SELECT email, name FROM users WHERE wallet_public_key = $1')) {
        return {
          rows: [{ email: `email-${params[0]}@test.com`, name: `User ${params[0]}` }]
        };
      }
      if (text.includes('FROM contributions c') && text.includes('withdrawal_requests')) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const { actions } = buildActions({
    db: mockDb,
    modules: {
      './sorobanService': mockSorobanService,
      './emailService': {
        sendCampaignFailedCreatorEmail: async () => {},
        sendCampaignFailedContributorEmail: async () => {},
        sendEmail: async (options) => {
          sentEmails.push(options);
        }
      }
    }
  });

  await actions.queueFailedCampaignRefunds('failed-campaign-id', 'creator-1');

  // Assertions:
  // 1. Should call refund for both. fail-key fails, so it's retried 3 times.
  assert.equal(refundCalls.length, 4);
  assert.deepEqual(refundCalls[0], { contractId: 'escrow-123', contributorPublicKey: 'user-key-1' });
  assert.deepEqual(refundCalls[1], { contractId: 'escrow-123', contributorPublicKey: 'fail-key' });
  assert.deepEqual(refundCalls[2], { contractId: 'escrow-123', contributorPublicKey: 'fail-key' });
  assert.deepEqual(refundCalls[3], { contractId: 'escrow-123', contributorPublicKey: 'fail-key' });

  // 2. Should update refunded = TRUE in DB only for successful one
  const updateQuery = dbQueries.find(q => q.text.includes('UPDATE contributions') && q.text.includes('refunded = TRUE') && q.params[0] === 'contrib-1');
  assert.ok(updateQuery);

  const failedUpdateQuery = dbQueries.filter(q => q.text.includes('UPDATE contributions') && q.text.includes('refunded = TRUE') && q.params[0] === 'contrib-2');
  assert.equal(failedUpdateQuery.length, 0);

  // 3. Should send email only for successful one
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'email-user-key-1@test.com');
  assert.ok(sentEmails[0].subject.includes('Refund processed'));
});

