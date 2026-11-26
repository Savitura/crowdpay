'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LIMITS,
  VelocityLimitError,
  getVelocityLimit,
  countRecentAttempts,
  checkVelocityLimit,
  assertVelocityLimit,
} = require('./velocityLimitService');

function fakeQuery(count, calls = []) {
  return async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ count }] };
  };
}

test('getVelocityLimit uses secure defaults and env overrides', () => {
  assert.deepEqual(getVelocityLimit('withdrawal', {}), {
    kind: 'withdrawal',
    label: 'Withdrawal',
    maxRequests: DEFAULT_LIMITS.withdrawal.maxRequests,
    windowSeconds: DEFAULT_LIMITS.withdrawal.windowSeconds,
    enabled: true,
  });

  const overridden = getVelocityLimit('refund', {
    REFUND_VELOCITY_MAX_REQUESTS: '3',
    REFUND_VELOCITY_WINDOW_SECONDS: '120',
  });
  assert.equal(overridden.maxRequests, 3);
  assert.equal(overridden.windowSeconds, 120);
  assert.equal(overridden.enabled, true);
});

test('getVelocityLimit disables enforcement when max requests is zero', () => {
  const limit = getVelocityLimit('withdrawal', { WITHDRAWAL_VELOCITY_MAX_REQUESTS: '0' });
  assert.equal(limit.enabled, false);
});

test('getVelocityLimit ignores invalid values and falls back to defaults', () => {
  const limit = getVelocityLimit('withdrawal', {
    WITHDRAWAL_VELOCITY_MAX_REQUESTS: 'not-a-number',
    WITHDRAWAL_VELOCITY_WINDOW_SECONDS: '-5',
  });
  assert.equal(limit.maxRequests, DEFAULT_LIMITS.withdrawal.maxRequests);
  assert.equal(limit.windowSeconds, DEFAULT_LIMITS.withdrawal.windowSeconds);
});

test('countRecentAttempts counts withdrawal rows in the rolling window per actor', async () => {
  const calls = [];
  const now = new Date('2026-01-01T12:00:00.000Z');
  const count = await countRecentAttempts({
    kind: 'withdrawal',
    actorId: 'user-1',
    query: fakeQuery(2, calls),
    now,
    windowSeconds: 3600,
  });

  assert.equal(count, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM withdrawal_requests/);
  assert.match(calls[0].text, /requested_by = \$1/);
  assert.equal(calls[0].params[0], 'user-1');
  assert.equal(calls[0].params[1].toISOString(), '2026-01-01T11:00:00.000Z');
});

test('countRecentAttempts counts refund rows by contributor', async () => {
  const calls = [];
  const count = await countRecentAttempts({
    kind: 'refund',
    actorId: 'contributor-1',
    query: fakeQuery(7, calls),
    now: new Date('2026-01-01T00:00:00.000Z'),
    windowSeconds: 60,
  });

  assert.equal(count, 7);
  assert.match(calls[0].text, /FROM refund_requests/);
  assert.match(calls[0].text, /contributor_id = \$1/);
});

test('countRecentAttempts treats an empty result as zero', async () => {
  const count = await countRecentAttempts({
    kind: 'withdrawal',
    actorId: 'user-1',
    query: async () => ({ rows: [] }),
  });
  assert.equal(count, 0);
});

test('checkVelocityLimit allows an actor below the limit (primary path)', async () => {
  const result = await checkVelocityLimit({
    kind: 'withdrawal',
    actorId: 'user-1',
    query: fakeQuery(4),
    env: { WITHDRAWAL_VELOCITY_MAX_REQUESTS: '5' },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.count, 4);
  assert.equal(result.maxRequests, 5);
});

test('checkVelocityLimit blocks the next attempt at the boundary', async () => {
  const result = await checkVelocityLimit({
    kind: 'refund',
    actorId: 'contributor-1',
    query: fakeQuery(10),
    env: { REFUND_VELOCITY_MAX_REQUESTS: '10' },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.count, 10);
});

test('assertVelocityLimit throws a 429 VelocityLimitError when exceeded', async () => {
  await assert.rejects(
    () =>
      assertVelocityLimit({
        kind: 'withdrawal',
        actorId: 'user-1',
        query: fakeQuery(6),
        env: { WITHDRAWAL_VELOCITY_MAX_REQUESTS: '5', WITHDRAWAL_VELOCITY_WINDOW_SECONDS: '60' },
      }),
    error => {
      assert.ok(error instanceof VelocityLimitError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'VELOCITY_LIMIT_EXCEEDED');
      assert.equal(error.retryAfterSeconds, 60);
      assert.equal(error.details.label, 'Withdrawal');
      return true;
    }
  );
});

test('checkVelocityLimit skips when disabled or no actor is present', async () => {
  const disabled = await checkVelocityLimit({
    kind: 'withdrawal',
    actorId: 'user-1',
    query: async () => {
      throw new Error('must not query');
    },
    env: { WITHDRAWAL_VELOCITY_MAX_REQUESTS: '0' },
  });
  assert.equal(disabled.allowed, true);
  assert.equal(disabled.skipped, true);

  const anonymous = await checkVelocityLimit({
    kind: 'refund',
    actorId: null,
    query: async () => {
      throw new Error('must not query');
    },
  });
  assert.equal(anonymous.allowed, true);
  assert.equal(anonymous.skipped, true);
});

test('unknown velocity limit kinds are rejected', () => {
  assert.throws(() => getVelocityLimit('transfer', {}), /Unknown velocity limit kind/);
});
