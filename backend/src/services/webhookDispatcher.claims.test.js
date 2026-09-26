// Concurrency-safety of webhook delivery processing (#838).
//
// The dispatcher is driven against an in-memory model of the delivery tables
// that applies each claim / finish / fail statement atomically (as Postgres
// row locking does), with an event-loop yield before every statement so
// concurrent callers genuinely interleave. The SQL itself is exercised against
// a real database in webhookDispatcher.claims.pg.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const LEASE_MS = 60_000;

function createFakeDb({ now }) {
  const deliveries = new Map();
  const hooks = new Map();
  const statements = [];

  const claimable = (d) =>
    d.status === 'pending' ||
    (d.status === 'retrying' && (d.next_retry_at === null || d.next_retry_at <= now())) ||
    (d.status === 'delivering' && (d.lease_expires_at ?? d.updated_at + LEASE_MS) <= now());

  const usable = (h) => (h.kind === 'user' ? !h.revoked_at : h.active === true);

  async function query(text, params = []) {
    // Yield so that concurrent callers interleave between statements.
    await new Promise((resolve) => setImmediate(resolve));
    statements.push(text);

    if (/SET status = 'delivering', attempt_count = d\.attempt_count \+ 1/.test(text)) {
      const [id, token, leaseMs, max] = params;
      const d = deliveries.get(id);
      const h = d && hooks.get(d.webhook_id);
      if (!d || !usable(h) || d.attempt_count >= max || !claimable(d)) return { rows: [] };
      Object.assign(d, {
        status: 'delivering',
        attempt_count: d.attempt_count + 1,
        lease_token: token,
        lease_expires_at: now() + leaseMs,
        next_retry_at: null,
        updated_at: now(),
      });
      return {
        rows: [{
          id: d.id,
          attempt_count: d.attempt_count,
          payload: d.payload,
          event_type: d.event_type,
          lease_token: token,
          url: h.url,
          secret: 'whsec_test',
          backoff_strategy: h.backoff_strategy || null,
        }],
      };
    }

    if (/SET status = 'failed',\s+last_error = CASE/.test(text)) {
      const [id, max] = params;
      const d = deliveries.get(id);
      const h = d && hooks.get(d.webhook_id);
      if (!d || !claimable(d) || (usable(h) && d.attempt_count < max)) return { rows: [] };
      Object.assign(d, {
        status: 'failed',
        last_error: usable(h) ? 'max delivery attempts exceeded' : h.kind === 'user' ? 'webhook revoked' : 'webhook disabled',
        lease_token: null,
        lease_expires_at: null,
      });
      return { rows: [{ id: d.id, last_error: d.last_error }] };
    }

    if (/WHERE id = \$1 AND lease_token = \$2 AND status = 'delivering'/.test(text)) {
      const [id, token, p3, p4] = params;
      const d = deliveries.get(id);
      if (!d || d.lease_token !== token || d.status !== 'delivering') return { rows: [] };
      const status = /SET status = '(\w+)'/.exec(text)[1];
      if (status === 'delivered') Object.assign(d, { response_status: p3 });
      if (status === 'retrying') Object.assign(d, { next_retry_at: now() + p3, last_error: p4 });
      if (status === 'failed') Object.assign(d, { last_error: p3 });
      Object.assign(d, { status, lease_token: null, lease_expires_at: null, updated_at: now() });
      return { rows: [{ id }] };
    }

    if (/SELECT d\.id FROM (webhook_deliveries|campaign_webhook_deliveries) d/.test(text)) {
      const table = /FROM (\w+) d/.exec(text)[1];
      const kind = table === 'webhook_deliveries' ? 'user' : 'campaign';
      const rows = [...deliveries.values()]
        .filter((d) => hooks.get(d.webhook_id).kind === kind)
        .filter((d) =>
          (d.status === 'retrying' && d.next_retry_at !== null && d.next_retry_at <= now()) ||
          (d.status === 'delivering' && (d.lease_expires_at ?? d.updated_at + LEASE_MS) <= now()) ||
          (d.status === 'pending' && d.updated_at <= now() - LEASE_MS))
        .map((d) => ({ id: d.id }));
      return { rows };
    }

    return { rows: [] };
  }

  function addDelivery(id, { kind = 'user', ...overrides } = {}) {
    const webhookId = `hook-${kind}`;
    if (!hooks.has(webhookId)) {
      hooks.set(webhookId, { kind, url: 'https://receiver.example/hook', revoked_at: null, active: true });
    }
    deliveries.set(id, {
      id,
      webhook_id: webhookId,
      status: 'pending',
      attempt_count: 0,
      payload: { n: 1 },
      event_type: 'campaign.funded',
      lease_token: null,
      lease_expires_at: null,
      next_retry_at: null,
      updated_at: now(),
      ...overrides,
    });
    return deliveries.get(id);
  }

  return { query, deliveries, hooks, statements, addDelivery };
}

function setup({ fetchImpl } = {}) {
  let clock = Date.parse('2026-09-25T12:00:00Z');
  const now = () => clock;
  const fakeDb = createFakeDb({ now });
  const sent = [];
  const warnings = [];

  const safeFetch = async (url, opts) => {
    sent.push({ url, deliveryId: opts.headers['X-CrowdPay-Delivery-Id'] });
    if (fetchImpl) return fetchImpl(url, opts, sent.length);
    return { ok: true, status: 200, text: async () => 'ok' };
  };

  const dispatcher = proxyquire('./webhookDispatcher', {
    '../config/database': { query: fakeDb.query },
    '../config/logger': { error: () => {}, warn: (msg) => warnings.push(msg), info: () => {} },
    './emailService': { sendEmail: async () => {} },
    '../utils/safeFetch': { safeFetch },
  });

  return {
    dispatcher,
    db: fakeDb,
    sent,
    warnings,
    advance: (ms) => { clock += ms; },
  };
}

test('two concurrent workers send at most one request for the same delivery', async () => {
  const { dispatcher, db, sent } = setup();
  db.addDelivery('d1');

  await Promise.all([dispatcher.processDelivery('d1'), dispatcher.processDelivery('d1')]);

  assert.equal(sent.length, 1);
  const d = db.deliveries.get('d1');
  assert.equal(d.status, 'delivered');
  assert.equal(d.attempt_count, 1, 'attempt_count counts the one real attempt');
});

test('two concurrent pollers claim each due retry once', async () => {
  const { dispatcher, db, sent, advance } = setup();
  const due = Date.parse('2026-09-25T12:00:00Z');
  db.addDelivery('d1', { status: 'retrying', attempt_count: 1, next_retry_at: due });
  db.addDelivery('d2', { status: 'retrying', attempt_count: 2, next_retry_at: due });
  advance(1);

  await Promise.all([dispatcher.processDueRetries(), dispatcher.processDueRetries()]);

  assert.deepEqual(sent.map((s) => s.deliveryId).sort(), ['d1', 'd2']);
  assert.equal(db.deliveries.get('d1').attempt_count, 2);
  assert.equal(db.deliveries.get('d2').attempt_count, 3);
});

test('a retry timer overlapping the poller produces a single attempt', async () => {
  const { dispatcher, db, sent } = setup();
  db.addDelivery('d1', { status: 'retrying', attempt_count: 1, next_retry_at: Date.parse('2026-09-25T11:59:00Z') });

  // The timer path and the poller path both reach processDelivery.
  await Promise.all([dispatcher.processDelivery('d1'), dispatcher.processDueRetries()]);

  assert.equal(sent.length, 1);
  assert.equal(db.deliveries.get('d1').attempt_count, 2);
});

test('a retry that is not yet due is not sent early by a timer', async () => {
  const { dispatcher, db, sent } = setup();
  db.addDelivery('d1', { status: 'retrying', attempt_count: 1, next_retry_at: Date.parse('2026-09-25T13:00:00Z') });

  await dispatcher.processDelivery('d1');

  assert.equal(sent.length, 0);
  assert.equal(db.deliveries.get('d1').status, 'retrying');
  assert.equal(db.deliveries.get('d1').attempt_count, 1);
});

test('an in-flight delivery with a live lease is not reclaimed', async () => {
  const { dispatcher, db, sent } = setup();
  db.addDelivery('d1', { status: 'delivering', attempt_count: 1, lease_token: 'worker-a', lease_expires_at: Date.parse('2026-09-25T12:00:30Z') });

  await dispatcher.processDueRetries();
  await dispatcher.processDelivery('d1');

  assert.equal(sent.length, 0);
  assert.equal(db.deliveries.get('d1').lease_token, 'worker-a');
});

test('after a process restart an expired lease is recovered by the poller', async () => {
  const { dispatcher, db, sent, advance } = setup();
  // Worker crashed mid-attempt: row left 'delivering' with its lease.
  db.addDelivery('d1', { status: 'delivering', attempt_count: 1, lease_token: 'dead-worker', lease_expires_at: Date.parse('2026-09-25T12:00:30Z') });
  // Process died before the immediate dispatch of a freshly queued row ran.
  db.addDelivery('d2', { status: 'pending', attempt_count: 0 });
  advance(LEASE_MS + 1);

  await dispatcher.processDueRetries();

  assert.deepEqual(sent.map((s) => s.deliveryId).sort(), ['d1', 'd2']);
  const d1 = db.deliveries.get('d1');
  assert.equal(d1.status, 'delivered');
  assert.equal(d1.attempt_count, 2, 'the crashed attempt and the recovery attempt are both counted');
  assert.equal(db.deliveries.get('d2').attempt_count, 1);
});

test('a crashed final attempt is closed out as failed instead of staying stuck', async () => {
  const { dispatcher, db, sent, advance } = setup();
  db.addDelivery('d1', { status: 'delivering', attempt_count: 5, lease_token: 'dead-worker', lease_expires_at: Date.parse('2026-09-25T12:00:00Z') });
  advance(1);

  await dispatcher.processDueRetries();

  assert.equal(sent.length, 0);
  assert.equal(db.deliveries.get('d1').status, 'failed');
  assert.equal(db.deliveries.get('d1').last_error, 'max delivery attempts exceeded');
});

test('a timed-out attempt schedules a retry and releases the lease', async () => {
  const { dispatcher, db } = setup({
    fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); },
  });
  db.addDelivery('d1');

  await dispatcher.processDelivery('d1');

  const d = db.deliveries.get('d1');
  assert.equal(d.status, 'retrying');
  assert.equal(d.attempt_count, 1);
  assert.equal(d.lease_token, null);
  assert.match(d.last_error, /timeout/);
  assert.ok(d.next_retry_at > Date.parse('2026-09-25T12:00:00Z'));
});

test('an attempt whose lease was reclaimed cannot overwrite the newer attempt', async () => {
  let releaseSlow;
  const { dispatcher, db, sent, warnings, advance } = setup({
    fetchImpl: (_url, _opts, n) => {
      if (n === 1) {
        // First attempt hangs past its lease, then fails.
        return new Promise((resolve) => { releaseSlow = () => resolve({ ok: false, status: 500, text: async () => 'boom' }); });
      }
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });
  db.addDelivery('d1');

  const slow = dispatcher.processDelivery('d1');
  while (!releaseSlow) await new Promise((r) => setImmediate(r));
  advance(LEASE_MS + 1);
  await dispatcher.processDueRetries();
  assert.equal(db.deliveries.get('d1').status, 'delivered');

  releaseSlow();
  await slow;

  const d = db.deliveries.get('d1');
  assert.equal(sent.length, 2);
  assert.equal(d.status, 'delivered', 'stale outcome must not regress a delivered row');
  assert.equal(d.attempt_count, 2);
  assert.ok(warnings.some((w) => /lease no longer held/.test(w)));
});

test('a failed attempt followed by a successful retry ends delivered with two attempts', async () => {
  const { dispatcher, db, sent, advance } = setup({
    fetchImpl: (_url, _opts, n) => (n === 1
      ? { ok: false, status: 503, text: async () => 'unavailable' }
      : { ok: true, status: 200, text: async () => 'ok' }),
  });
  db.addDelivery('d1');

  await dispatcher.processDelivery('d1');
  assert.equal(db.deliveries.get('d1').status, 'retrying');

  advance(60_000 + 1);
  await Promise.all([dispatcher.processDueRetries(), dispatcher.processDelivery('d1')]);

  const d = db.deliveries.get('d1');
  assert.equal(sent.length, 2);
  assert.equal(d.status, 'delivered');
  assert.equal(d.attempt_count, 2);
  assert.ok(sent.every((s) => s.deliveryId === 'd1'), 'delivery ID is the stable receiver dedup key');
});

test('campaign webhook deliveries are claimed the same way', async () => {
  const { dispatcher, db, sent } = setup();
  db.addDelivery('c1', { kind: 'campaign' });

  await Promise.all([
    dispatcher.processCampaignWebhookDelivery('c1'),
    dispatcher.processCampaignWebhookDelivery('c1'),
    dispatcher.processDueCampaignWebhookRetries(),
  ]);

  assert.equal(sent.length, 1);
  assert.equal(db.deliveries.get('c1').status, 'delivered');
  assert.equal(db.deliveries.get('c1').attempt_count, 1);
});

test('a revoked webhook fails its queued delivery without sending', async () => {
  const { dispatcher, db, sent } = setup();
  db.addDelivery('d1');
  db.hooks.get('hook-user').revoked_at = new Date();

  await dispatcher.processDelivery('d1');

  assert.equal(sent.length, 0);
  assert.equal(db.deliveries.get('d1').status, 'failed');
  assert.equal(db.deliveries.get('d1').last_error, 'webhook revoked');
});
