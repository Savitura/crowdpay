const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const proxyquire = require('proxyquire').noCallThru();

const originalThreshold = process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD;

let queryLog = [];
let sentryMessages = [];
let connectClient;

function buildReconciliation(overrides = {}) {
  queryLog = [];
  sentryMessages = [];

  connectClient = {
    query: async (text, params) => {
      queryLog.push({ text, params, via: 'client' });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('UPDATE campaigns SET raised_amount')) {
        return { rows: [{ id: params[1] }] };
      }
      if (text.includes('INSERT INTO stellar_transactions')) {
        return { rows: [{ id: 'stellar-tx-1' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const mockDb = {
    query: async (text, params) => {
      queryLog.push({ text, params, via: 'pool' });
      if (text.includes('FROM withdrawal_requests') && text.includes('pending')) {
        return { rows: overrides.pendingWithdrawal ? [{ id: 'w-1' }] : [] };
      }
      if (text.includes('FROM campaigns WHERE id = $1')) {
        return {
          rows: [{
            id: 'camp-1',
            wallet_public_key: 'GWALLET',
            asset_type: 'USDC',
            raised_amount: '100',
            target_amount: '1000',
            status: 'active',
          }],
        };
      }
      if (text.includes('FROM campaigns') && text.includes("status IN ('active', 'funded')")) {
        return {
          rows: [{
            id: 'camp-1',
            wallet_public_key: 'GWALLET',
            asset_type: 'USDC',
            raised_amount: '100',
            target_amount: '1000',
            status: 'active',
          }],
        };
      }
      return { rows: [] };
    },
    connect: async () => connectClient,
  };

  const mockSentry = {
    withScope: (fn) => {
      const scope = {
        setLevel: () => {},
        setTag: () => {},
        setContext: () => {},
      };
      fn(scope);
    },
    captureMessage: (message) => {
      sentryMessages.push(message);
    },
  };

  return proxyquire('./reconciliation', {
    '../config/database': mockDb,
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    '../utils/cache': {
      invalidate: () => {},
      invalidatePrefix: () => {},
    },
    './stellarService': {
      getCampaignBalance: async () => overrides.onChainBalance || { USDC: '150' },
    },
    './stellarTransactionService': {
      insertReconciliationAdjustment: async (client, row) => {
        queryLog.push({ text: 'insertReconciliationAdjustment', row, via: 'service' });
        const result = await client.query(
          `INSERT INTO stellar_transactions (kind, status, campaign_id, metadata) VALUES ('contribution', 'indexed', $1, $2)`,
          [row.campaignId, JSON.stringify(row)]
        );
        return result.rows[0]?.id || 'stellar-tx-1';
      },
    },
    '@sentry/node': mockSentry,
    ...overrides.proxyquire,
  });
}

beforeEach(() => {
  process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD = '10';
});

afterEach(() => {
  if (originalThreshold === undefined) {
    delete process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD;
  } else {
    process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD = originalThreshold;
  }
});

test('hasDiscrepancy detects balance drift above epsilon', () => {
  const { hasDiscrepancy, DISCREPANCY_EPSILON } = buildReconciliation();
  assert.strictEqual(hasDiscrepancy(100, 100), false);
  assert.strictEqual(hasDiscrepancy(100, 100 + DISCREPANCY_EPSILON * 2), true);
});

test('reconcileCampaign updates raised_amount and records stellar_transactions on drift', async () => {
  const reconciliation = buildReconciliation();
  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.dbBalance, 100);
  assert.strictEqual(result.liveBalance, 150);
  assert.strictEqual(result.diff, 50);
  assert.strictEqual(result.stellar_transaction_id, 'stellar-tx-1');

  assert.ok(queryLog.some((q) => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount')));
  assert.ok(
    queryLog.some((q) => q.text.includes('INSERT INTO stellar_transactions') || q.text === 'insertReconciliationAdjustment')
  );
});

test('reconcileCampaign skips campaigns with pending withdrawals', async () => {
  const reconciliation = buildReconciliation({ pendingWithdrawal: true });
  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'pending_withdrawal');
  assert.ok(!queryLog.some((q) => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount')));
});

test('reconcileCampaign fires Sentry when diff exceeds threshold', async () => {
  const reconciliation = buildReconciliation({ onChainBalance: { USDC: '200' } });
  await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(sentryMessages.length, 1);
  assert.match(sentryMessages[0], /reconciliation discrepancy/i);
});

test('reconcileCampaign does not fire Sentry when diff is below threshold', async () => {
  process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD = '100';
  const reconciliation = buildReconciliation({ onChainBalance: { USDC: '150' } });
  await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(sentryMessages.length, 0);
});

test('reconcileCampaignBalances returns batch summary', async () => {
  const reconciliation = buildReconciliation();
  const summary = await reconciliation.reconcileCampaignBalances();

  assert.strictEqual(summary.campaigns_checked, 1);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.results[0].diff, 50);
});
