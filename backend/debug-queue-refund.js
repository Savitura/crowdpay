const proxyquire = require('proxyquire').noCallThru();
const refundCalls = [];
const mockSorobanService = {
  triggerRefund: async (contractId, contributorPublicKey) => {
    refundCalls.push({ contractId, contributorPublicKey });
    if (contributorPublicKey === 'fail-key') {
      throw new Error('Soroban error');
    }
  },
};
const mockDb = {
  query: async (text, params) => {
    console.log('QUERY:', text.replace(/\s+/g, ' '), 'PARAMS:', params);
    if (text.includes('SELECT id, wallet_public_key, status, creator_id, escrow_contract_id, title FROM campaigns')) {
      return {
        rows: [{ id: 'failed-campaign-id', wallet_public_key: 'GPK', status: 'failed', creator_id: 'creator-1', escrow_contract_id: 'escrow-123', title: 'Failed Campaign' }],
      };
    }
    if (text.includes('FROM contributions WHERE campaign_id = $1 AND refunded = FALSE')) {
      return {
        rows: [
          { id: 'contrib-1', sender_public_key: 'user-key-1', amount: '10.0', asset: 'USDC' },
          { id: 'contrib-2', sender_public_key: 'fail-key', amount: '5.0', asset: 'XLM' },
        ],
      };
    }
    if (text.includes('SELECT email, name FROM users WHERE wallet_public_key = $1')) {
      return { rows: [{ email: `email-${params[0]}@test.com`, name: `User ${params[0]}` }] };
    }
    if (text.includes('FROM contributions c') && text.includes('withdrawal_requests')) {
      return { rows: [] };
    }
    return { rows: [] };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
};
process.env.PLATFORM_SECRET_KEY = 'test-secret-key';
const actions = proxyquire('./src/services/campaignStatusActions', {
  '../config/database': mockDb,
  '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  './emailService': {
    sendCampaignFailedCreatorEmail: async () => {},
    sendCampaignFailedContributorEmail: async () => {},
    sendEmail: async () => {},
  },
  './notifications': { createNotification: async () => {} },
  './webhookDispatcher': {
    WEBHOOK_EVENTS: { CAMPAIGN_FUNDED: 'campaign.funded', CAMPAIGN_FAILED: 'campaign.failed' },
    emitWebhookEventForUser: async () => {},
    emitWebhookEventForCampaign: async () => {},
  },
  './stellarService': { buildWithdrawalTransaction: async () => 'unsigned-xdr' },
  './stellarTransactionService': { insertWithdrawalPendingSignatures: async () => {} },
  './sorobanService': mockSorobanService,
});
(async () => {
  try {
    const result = await actions.queueFailedCampaignRefunds('failed-campaign-id', 'creator-1');
    console.log('RESULT:', result);
    console.log('REFUND CALLS:', refundCalls);
  } catch (err) {
    console.error('ERROR:', err);
  }
})();
