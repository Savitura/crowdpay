const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const proxyquire = require('proxyquire').noCallThru();

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FRAUD_WEIGHT_SAME_IP = '20';
  process.env.FRAUD_THRESHOLD_SAME_IP = '3';
  process.env.FRAUD_WINDOW_SAME_IP_MS = '86400000';
  process.env.FRAUD_WEIGHT_WALLET_AGE = '30';
  process.env.FRAUD_THRESHOLD_WALLET_AGE_MS = '3600000';
  process.env.FRAUD_WEIGHT_VELOCITY = '40';
  process.env.FRAUD_VELOCITY_MULTIPLIER = '3';
  process.env.FRAUD_VELOCITY_WINDOW_MS = '3600000';
  process.env.FRAUD_VELOCITY_MIN_AMOUNT = '10';
  process.env.FRAUD_WEIGHT_SINGLE_WALLET = '35';
  process.env.FRAUD_THRESHOLD_SINGLE_WALLET_PCT = '0.50';
  process.env.FRAUD_THRESHOLD = '50';
  process.env.FRAUD_AUTO_PAUSE_THRESHOLD = '80';
  process.env.FRAUD_AUTO_PAUSE_ENABLED = 'true';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function buildFraudService(mocks) {
  return proxyquire('./fraudService', {
    '../config/database': mocks.db || {
      query: async () => ({ rows: [] }),
    },
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    './alerting': {
      sendAlert: async () => {},
    },
    './emailService': {
      sendCampaignFraudFlaggedEmail: async () => {},
    },
    '@sentry/node': {
      captureException: () => {},
    },
  });
}

describe('FraudService', () => {
  test('evaluateCampaign with low risk campaign remains active and unflagged', async () => {
    let updateQueryCalled = false;
    const dbMock = {
      query: async (text, params) => {
        if (text.includes('SELECT') && text.includes('target_amount') && text.includes('campaigns')) {
          return {
            rows: [{
              id: 'campaign-1',
              title: 'Clean Campaign',
              target_amount: 1000,
              raised_amount: 100,
              created_at: new Date(Date.now() - 10 * 3600 * 1000).toISOString(), // 10h ago
              status: 'active',
              is_flagged_fraud: false,
            }],
          };
        }
        if (text.includes('ip_address') && text.includes('HAVING COUNT(*)')) {
          // No IPs exceeding threshold
          return { rows: [] };
        }
        if (text.includes('JOIN users')) {
          // No wallets created < 1h ago
          return { rows: [{ count: 0 }] };
        }
        if (text.includes('COALESCE(SUM(amount)')) {
          // No contributions in last hour
          return { rows: [{ window_amount: 0 }] };
        }
        if (text.includes('SUM(amount)') && text.includes('GROUP BY sender_public_key')) {
          // Single contributor contributed 10%
          return { rows: [{ sender_public_key: 'G1', total_amount: 100 }] };
        }
        if (text.includes('UPDATE campaigns')) {
          updateQueryCalled = true;
          assert.strictEqual(params[0], false); // is_flagged_fraud = FALSE
          assert.strictEqual(params[1], 0); // fraud_score = 0
          assert.strictEqual(params[3], 'active'); // status remains active
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const fraudService = buildFraudService({ db: dbMock });
    const result = await fraudService.evaluateCampaign('campaign-1');
    
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.is_flagged_fraud, false);
    assert.strictEqual(result.auto_suspended, false);
    assert.ok(updateQueryCalled);
  });

  test('evaluateCampaign flags and suspends campaign with high score', async () => {
    let updateQueryCalled = false;
    let alertsSent = false;

    const dbMock = {
      query: async (text, params) => {
        if (text.includes('SELECT') && text.includes('target_amount') && text.includes('campaigns')) {
          return {
            rows: [{
              id: 'campaign-2',
              title: 'Attack Campaign',
              target_amount: 1000,
              raised_amount: 500,
              created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
              status: 'active',
              is_flagged_fraud: false,
            }],
          };
        }
        if (text.includes('ip_address') && text.includes('HAVING COUNT(*)')) {
          // One IP address with 6 contributions (6 - 3 = 3 over limit) -> score = 3 * 20 = 60
          return { rows: [{ ip_address: '1.2.3.4', count: 6 }] };
        }
        if (text.includes('JOIN users')) {
          // 1 wallet created < 1h ago -> score = 30
          return { rows: [{ count: 1 }] };
        }
        if (text.includes('COALESCE(SUM(amount)')) {
          return { rows: [{ window_amount: 100 }] };
        }
        if (text.includes('SUM(amount)') && text.includes('GROUP BY sender_public_key')) {
          return { rows: [{ sender_public_key: 'G1', total_amount: 100 }] };
        }
        if (text.includes("SELECT email, name FROM users WHERE role = 'admin'")) {
          return { rows: [{ email: 'admin@test.com', name: 'Admin' }] };
        }
        if (text.includes('UPDATE campaigns')) {
          updateQueryCalled = true;
          assert.strictEqual(params[0], true); // is_flagged_fraud = TRUE (score 90 >= 50)
          assert.strictEqual(params[1], 90); // fraud_score = 90
          assert.strictEqual(params[3], 'suspended'); // status updated to suspended (score 90 >= 80)
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const fraudService = proxyquire('./fraudService', {
      '../config/database': dbMock,
      '../config/logger': {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      './alerting': {
        sendAlert: async () => { alertsSent = true; },
      },
      './emailService': {
        sendCampaignFraudFlaggedEmail: async () => {},
      },
      '@sentry/node': {
        captureException: () => {},
      },
    });

    const result = await fraudService.evaluateCampaign('campaign-2');
    
    assert.strictEqual(result.score, 90);
    assert.strictEqual(result.is_flagged_fraud, true);
    assert.strictEqual(result.auto_suspended, true);
    assert.ok(updateQueryCalled);
    assert.ok(alertsSent);
  });
});
