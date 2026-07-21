const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const OWNER = 'owner-1';

// Build the service with a scripted db. `handlers` is an array of
// { match: (sql) => bool, rows: [...] } consulted in order; the first match
// wins. Unmatched queries return { rows: [] }. Every executed query is pushed
// to `queryLog` for assertions.
function buildService(handlers = []) {
  const queryLog = [];
  const notifications = [];

  const svc = proxyquire('./webhookService', {
    '../config/database': {
      query: async (sql, params) => {
        queryLog.push({ sql, params });
        for (const h of handlers) {
          if (h.match(sql)) return { rows: h.rows };
        }
        return { rows: [] };
      },
    },
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    './notifications': {
      createNotification: async (userId, msg) => {
        notifications.push({ userId, msg });
      },
    },
  });

  return { svc, queryLog, notifications };
}

// The webhook-owner lookup every processIncomingWebhook call performs.
const ownerLookup = { match: (s) => s.includes('SELECT user_id FROM webhooks'), rows: [{ user_id: OWNER }] };

// --- verifyWebhookSignature -------------------------------------------------

test('verifyWebhookSignature accepts a valid HMAC-SHA256 signature', () => {
  const { svc } = buildService();
  const secret = 'whsec_abc';
  const body = Buffer.from(JSON.stringify({ type: 'x' }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(svc.verifyWebhookSignature(secret, body, sig), true);
});

test('verifyWebhookSignature tolerates a sha256= prefix', () => {
  const { svc } = buildService();
  const secret = 'whsec_abc';
  const body = Buffer.from('{}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(svc.verifyWebhookSignature(secret, body, `sha256=${sig}`), true);
});

test('verifyWebhookSignature rejects a wrong signature', () => {
  const { svc } = buildService();
  const body = Buffer.from('{}');
  assert.equal(svc.verifyWebhookSignature('secret', body, 'deadbeef'), false);
});

test('verifyWebhookSignature rejects non-hex / empty / missing input', () => {
  const { svc } = buildService();
  const body = Buffer.from('{}');
  assert.equal(svc.verifyWebhookSignature('secret', body, 'not-hex-zz'), false);
  assert.equal(svc.verifyWebhookSignature('secret', body, ''), false);
  assert.equal(svc.verifyWebhookSignature('', body, 'aa'), false);
});

// --- routing / validation ---------------------------------------------------

test('processIncomingWebhook rejects a payload without a string type', async () => {
  const { svc } = buildService([ownerLookup]);
  await assert.rejects(() => svc.processIncomingWebhook('wh-1', {}, { ownerUserId: OWNER }), (e) => {
    assert.equal(e.name, 'WebhookError');
    assert.equal(e.status, 400);
    return true;
  });
});

test('processIncomingWebhook rejects an unknown event type', async () => {
  const { svc } = buildService([ownerLookup]);
  await assert.rejects(
    () => svc.processIncomingWebhook('wh-1', { type: 'nope.unknown' }, { ownerUserId: OWNER }),
    (e) => e.status === 400 && /Unsupported/.test(e.message)
  );
});

test('processIncomingWebhook looks up the owner when not supplied', async () => {
  const { svc, queryLog } = buildService([
    ownerLookup,
    { match: (s) => s.includes('FROM contributions'), rows: [] },
  ]);
  await svc.processIncomingWebhook('wh-1', { type: 'contribution.confirmed', tx_hash: 't1' });
  assert.ok(queryLog.some((q) => q.sql.includes('SELECT user_id FROM webhooks')));
});

test('processIncomingWebhook throws 404 when the webhook owner cannot be resolved', async () => {
  const { svc } = buildService([{ match: (s) => s.includes('SELECT user_id FROM webhooks'), rows: [] }]);
  await assert.rejects(
    () => svc.processIncomingWebhook('missing', { type: 'contribution.confirmed', tx_hash: 't' }),
    (e) => e.status === 404
  );
});

// --- contribution.confirmed -------------------------------------------------

test('contribution.confirmed links an indexed contribution without touching raised_amount', async () => {
  const { svc, queryLog, notifications } = buildService([
    {
      match: (s) => s.includes('FROM contributions'),
      rows: [{ id: 'c-1', campaign_id: 'cam-1', amount: '50', asset: 'USDC', title: 'Save Bees' }],
    },
  ]);
  const res = await svc.processIncomingWebhook(
    'wh-1',
    { type: 'contribution.confirmed', tx_hash: 'tx-1' },
    { ownerUserId: OWNER }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.contribution_id, 'c-1');
  assert.equal(notifications.length, 1);
  // Must never mutate campaign raised_amount from an inbound webhook.
  assert.ok(!queryLog.some((q) => /UPDATE campaigns[\s\S]*raised_amount/.test(q.sql)));
});

test('contribution.confirmed acknowledges (202) when not yet indexed', async () => {
  const { svc, notifications } = buildService([
    { match: (s) => s.includes('FROM contributions'), rows: [] },
  ]);
  const res = await svc.processIncomingWebhook(
    'wh-1',
    { type: 'contribution.confirmed', tx_hash: 'tx-unknown' },
    { ownerUserId: OWNER }
  );
  assert.equal(res.status, 202);
  assert.equal(res.body.linked, false);
  assert.equal(notifications.length, 0);
});

test('contribution.confirmed requires tx_hash', async () => {
  const { svc } = buildService([ownerLookup]);
  await assert.rejects(
    () => svc.processIncomingWebhook('wh-1', { type: 'contribution.confirmed' }, { ownerUserId: OWNER }),
    (e) => e.status === 400
  );
});

// --- withdrawal.completed ---------------------------------------------------

test('withdrawal.completed transitions a pending request to submitted', async () => {
  const { svc, notifications } = buildService([
    {
      match: (s) => s.includes('UPDATE withdrawal_requests'),
      rows: [{ id: 'w-1', campaign_id: 'cam-1', amount: '100', status: 'submitted', tx_hash: 'h1' }],
    },
  ]);
  const res = await svc.processIncomingWebhook(
    'wh-1',
    { type: 'withdrawal.completed', withdrawal_id: 'w-1', tx_hash: 'h1' },
    { ownerUserId: OWNER }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');
  assert.equal(notifications.length, 1);
});

test('withdrawal.completed returns 404 for a withdrawal the owner does not own', async () => {
  const { svc } = buildService([
    { match: (s) => s.includes('UPDATE withdrawal_requests'), rows: [] },
    { match: (s) => s.includes('SELECT wr.id FROM withdrawal_requests'), rows: [] },
  ]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'withdrawal.completed', withdrawal_id: 'w-x' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 404
  );
});

test('withdrawal.completed returns 409 when the request is in a non-completable state', async () => {
  const { svc } = buildService([
    { match: (s) => s.includes('UPDATE withdrawal_requests'), rows: [] },
    { match: (s) => s.includes('SELECT wr.id FROM withdrawal_requests'), rows: [{ id: 'w-1' }] },
  ]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'withdrawal.completed', withdrawal_id: 'w-1' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 409
  );
});

// --- anchor.deposit.updated -------------------------------------------------

test('anchor.deposit.updated records remote status and advances local lifecycle', async () => {
  const { svc, queryLog } = buildService([
    {
      match: (s) => s.includes('UPDATE anchor_deposits'),
      rows: [{ id: 'a-1', campaign_id: 'cam-1', status: 'deposit_completed' }],
    },
  ]);
  const res = await svc.processIncomingWebhook(
    'wh-1',
    {
      type: 'anchor.deposit.updated',
      anchor_id: 'anchor-x',
      anchor_transaction_id: 'atx-1',
      status: 'completed',
    },
    { ownerUserId: OWNER }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'deposit_completed');
  // Owner scoping: the update must be constrained by user_id.
  const upd = queryLog.find((q) => q.sql.includes('UPDATE anchor_deposits'));
  assert.ok(upd.sql.includes('user_id'));
  assert.ok(upd.params.includes(OWNER));
});

test('anchor.deposit.updated returns 404 when no matching deposit for the owner', async () => {
  const { svc } = buildService([
    { match: (s) => s.includes('UPDATE anchor_deposits'), rows: [] },
  ]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'anchor.deposit.updated', anchor_id: 'x', anchor_transaction_id: 'y', status: 'pending' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 404
  );
});

test('anchor.deposit.updated requires anchor_id and anchor_transaction_id', async () => {
  const { svc } = buildService([ownerLookup]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'anchor.deposit.updated', anchor_id: 'x' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 400
  );
});

// --- milestone.approved / milestone.rejected --------------------------------

test('milestone.approved transitions pending_review to approved and records an event', async () => {
  const { svc, queryLog, notifications } = buildService([
    {
      match: (s) => s.includes('UPDATE milestones'),
      rows: [{ id: 'm-1', campaign_id: 'cam-1', title: 'Beta', status: 'approved' }],
    },
  ]);
  const res = await svc.processIncomingWebhook(
    'wh-1',
    { type: 'milestone.approved', milestone_id: 'm-1' },
    { ownerUserId: OWNER }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.ok(queryLog.some((q) => q.sql.includes('INSERT INTO milestone_events')));
  assert.equal(notifications.length, 1);
});

test('milestone.rejected requires a reason', async () => {
  const { svc } = buildService([ownerLookup]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'milestone.rejected', milestone_id: 'm-1' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 400
  );
});

test('milestone decision returns 409 when the milestone is not awaiting review', async () => {
  const { svc } = buildService([
    { match: (s) => s.includes('UPDATE milestones'), rows: [] },
    { match: (s) => s.includes('SELECT m.id FROM milestones'), rows: [{ id: 'm-1' }] },
  ]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'milestone.approved', milestone_id: 'm-1' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 409
  );
});

test('milestone decision returns 404 when the milestone does not belong to the owner', async () => {
  const { svc } = buildService([
    { match: (s) => s.includes('UPDATE milestones'), rows: [] },
    { match: (s) => s.includes('SELECT m.id FROM milestones'), rows: [] },
  ]);
  await assert.rejects(
    () =>
      svc.processIncomingWebhook(
        'wh-1',
        { type: 'milestone.rejected', milestone_id: 'm-1', reason: 'insufficient evidence' },
        { ownerUserId: OWNER }
      ),
    (e) => e.status === 404
  );
});
