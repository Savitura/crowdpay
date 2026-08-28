const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

function loadDispatcher() {
  return proxyquire('./webhookDispatcher', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../config/logger': { error: () => {} },
    './emailService': { sendEmail: async () => {} },
  });
}

test('HMAC-SHA256 signature matches Node crypto verify pattern', () => {
  const { hmacSignature } = loadDispatcher();
  const secret = 'whsec_testsecret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = hmacSignature(secret, body);
  const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(sig, expected);
});

test('backoffMs uses the requested exponential schedule', () => {
  const { backoffMs } = loadDispatcher();
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 300_000);
  assert.equal(backoffMs(3), 1_800_000);
  assert.equal(backoffMs(4), 7_200_000);
  assert.equal(backoffMs(5), 86_400_000);
  assert.equal(backoffMs(6), 86_400_000);
});

test('WEBHOOK_EVENTS registers the new #434 event types', () => {
  const { WEBHOOK_EVENTS, ALL_WEBHOOK_EVENTS } = loadDispatcher();
  assert.equal(WEBHOOK_EVENTS.CONTRIBUTION_REFUNDED, 'contribution.refunded');
  assert.equal(WEBHOOK_EVENTS.MILESTONE_REJECTED, 'milestone.rejected');
  assert.equal(WEBHOOK_EVENTS.WITHDRAWAL_UPDATED, 'withdrawal.updated');
  assert.equal(WEBHOOK_EVENTS.DISPUTE_OPENED, 'dispute.opened');
  assert.equal(WEBHOOK_EVENTS.DISPUTE_RESOLVED, 'dispute.resolved');
  for (const event of Object.values(WEBHOOK_EVENTS)) {
    assert.ok(ALL_WEBHOOK_EVENTS.includes(event));
  }
});

test('isValidBackoffStrategy validates shape', () => {
  const { isValidBackoffStrategy } = loadDispatcher();
  assert.equal(isValidBackoffStrategy({ base_ms: 1000, max_ms: 60000, multiplier: 2 }), true);
  assert.equal(isValidBackoffStrategy(null), false);
  assert.equal(isValidBackoffStrategy({}), false);
  assert.equal(isValidBackoffStrategy({ base_ms: -1, max_ms: 60000, multiplier: 2 }), false);
  assert.equal(isValidBackoffStrategy({ base_ms: 1000, max_ms: 60000, multiplier: 0 }), false);
});

test('backoffMs uses a custom strategy when provided and valid', () => {
  const { backoffMs } = loadDispatcher();
  const strategy = { base_ms: 1000, max_ms: 10000, multiplier: 2 };
  assert.equal(backoffMs(1, strategy), 1000);
  assert.equal(backoffMs(2, strategy), 2000);
  assert.equal(backoffMs(3, strategy), 4000);
  assert.equal(backoffMs(10, strategy), 10000); // capped at max_ms
});

test('backoffMs falls back to the default schedule for an invalid strategy', () => {
  const { backoffMs } = loadDispatcher();
  assert.equal(backoffMs(1, { base_ms: -5 }), 60_000);
});

test('backoffMsForCampaign uses a custom strategy when provided and valid', () => {
  const { backoffMsForCampaign } = loadDispatcher();
  const strategy = { base_ms: 2000, max_ms: 20000, multiplier: 3 };
  assert.equal(backoffMsForCampaign(1, strategy), 2000);
  assert.equal(backoffMsForCampaign(2, strategy), 6000);
  assert.equal(backoffMsForCampaign(3, strategy), 18000);
});

test('backoffMsForCampaign falls back to the fixed default schedule without a strategy', () => {
  const { backoffMsForCampaign } = loadDispatcher();
  assert.equal(backoffMsForCampaign(1), 5000);
  assert.equal(backoffMsForCampaign(2), 30000);
  assert.equal(backoffMsForCampaign(3), 300000);
});

// ── duplicate dispatch prevention ───────────────────────────────────────────

test('processDelivery returns early when a concurrent process already claimed the delivery', async () => {
  const mockDb = {
    query: async (text) => {
      // First query: SELECT the delivery row (status = 'pending')
      if (text.includes('SELECT') && text.includes('webhook_deliveries')) {
        return {
          rows: [{
            id: 'del-1',
            attempt_count: 0,
            status: 'pending',
            payload: { event: 'test' },
            event_type: 'test.event',
            url: 'https://example.com/hook',
            secret: 'whsec_test',
            revoked_at: null,
            backoff_strategy: null,
          }],
        };
      }
      // Second query: UPDATE to 'delivering' — returns rowCount: 0 (concurrent claim)
      if (text.includes('UPDATE webhook_deliveries') && text.includes('delivering')) {
        return { rowCount: 0 };
      }
      return { rows: [] };
    },
  };

  const { processDelivery } = proxyquire('./webhookDispatcher', {
    '../config/database': mockDb,
    '../config/logger': { error: () => {} },
    './emailService': { sendEmail: async () => {} },
  });

  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '' }; };

  await processDelivery('del-1');
  assert.equal(fetchCalled, false, 'fetch must not be called when UPDATE returns zero rows');
  delete global.fetch;
});

test('processCampaignWebhookDelivery returns early when a concurrent process already claimed the delivery', async () => {
  const mockDb = {
    query: async (text) => {
      if (text.includes('SELECT') && text.includes('campaign_webhook_deliveries')) {
        return {
          rows: [{
            id: 'cwd-1',
            attempt_count: 0,
            status: 'pending',
            payload: { event: 'test' },
            event: 'test.event',
            url: 'https://example.com/hook',
            secret: 'whsec_test',
            active: true,
            backoff_strategy: null,
          }],
        };
      }
      if (text.includes('UPDATE campaign_webhook_deliveries') && text.includes('delivering')) {
        return { rowCount: 0 };
      }
      return { rows: [] };
    },
  };

  const { processCampaignWebhookDelivery } = proxyquire('./webhookDispatcher', {
    '../config/database': mockDb,
    '../config/logger': { error: () => {} },
    './emailService': { sendEmail: async () => {} },
  });

  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '' }; };

  await processCampaignWebhookDelivery('cwd-1');
  assert.equal(fetchCalled, false, 'fetch must not be called when UPDATE returns zero rows');
  delete global.fetch;
});
