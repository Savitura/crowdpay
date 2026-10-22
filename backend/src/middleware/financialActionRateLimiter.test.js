const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const silentLogger = { info: () => {}, error: () => {}, warn: () => {} };

const { createFinancialActionLimiter } = proxyquire('./financialActionRateLimiter', {
  '../config/redis': { pipeline: () => assert.fail('default client must not be used') },
  '../config/logger': silentLogger,
});

// In-memory stand-in for the ioredis pipeline used by the limiter.
function createFakeRedis() {
  const counts = new Map();
  return {
    counts,
    pipeline() {
      const commands = [];
      return {
        incr: key => commands.push(['incr', key]),
        expire: (key, seconds) => commands.push(['expire', key, seconds]),
        exec: async () =>
          commands.map(([op, key]) => {
            if (op !== 'incr') return [null, 1];
            counts.set(key, (counts.get(key) || 0) + 1);
            return [null, counts.get(key)];
          }),
      };
    },
  };
}

function createClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  const clock = { value: start, now: () => clock.value };
  return clock;
}

function buildLimiter({ redisClient, clock, limit = 3, windowSeconds = 60, action = 'test' } = {}) {
  return createFinancialActionLimiter({
    action,
    limitEnv: 'TEST_FIN_ATTEMPT_LIMIT',
    windowEnv: 'TEST_FIN_ATTEMPT_WINDOW_SECONDS',
    defaultLimit: limit,
    defaultWindowSeconds: windowSeconds,
    redisClient: redisClient || createFakeRedis(),
    now: clock ? clock.now : Date.now,
  });
}

function buildApp(limiter, { handlerCalls = { count: 0 } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-user');
    if (userId) req.user = { userId };
    next();
  });
  app.post('/action', limiter, (_req, res) => {
    handlerCalls.count += 1;
    res.status(201).json({ ok: true });
  });
  return app;
}

test('allows attempts up to the limit', async () => {
  const app = buildApp(buildLimiter({ clock: createClock(), limit: 3 }));
  for (let i = 0; i < 3; i += 1) {
    const res = await request(app).post('/action').set('x-user', 'u-1');
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
  }
});

test('the attempt after the limit gets 429 with Retry-After and the shared error shape', async () => {
  const clock = createClock(Date.UTC(2026, 0, 1, 0, 0, 15));
  const app = buildApp(buildLimiter({ clock, limit: 2, windowSeconds: 60 }));

  await request(app).post('/action').set('x-user', 'u-1');
  await request(app).post('/action').set('x-user', 'u-1');
  const res = await request(app).post('/action').set('x-user', 'u-1');

  assert.equal(res.status, 429);
  // 15s into a 60s window, so the bucket resets in 45s.
  assert.equal(res.headers['retry-after'], '45');
  assert.equal(res.body.error, 'Too Many Requests');
  assert.equal(typeof res.body.message, 'string');
  assert.equal(res.body.retry_after, 45);
});

test('a blocked attempt never reaches the handler', async () => {
  const handlerCalls = { count: 0 };
  const app = buildApp(buildLimiter({ clock: createClock(), limit: 1 }), { handlerCalls });

  await request(app).post('/action').set('x-user', 'u-1');
  const blocked = await request(app).post('/action').set('x-user', 'u-1');

  assert.equal(blocked.status, 429);
  assert.equal(handlerCalls.count, 1);
});

test('different users do not share a bucket', async () => {
  const app = buildApp(buildLimiter({ clock: createClock(), limit: 1 }));

  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 429);
  assert.equal((await request(app).post('/action').set('x-user', 'u-2')).status, 201);
});

test('withdrawal and refund buckets are independent for the same user', async () => {
  const redisClient = createFakeRedis();
  const clock = createClock();
  const app = express();
  app.use((req, _res, next) => {
    req.user = { userId: 'u-1' };
    next();
  });
  const ok = (_req, res) => res.status(201).end();
  app.post('/w', buildLimiter({ redisClient, clock, limit: 1, action: 'withdrawal' }), ok);
  app.post('/r', buildLimiter({ redisClient, clock, limit: 1, action: 'refund' }), ok);

  assert.equal((await request(app).post('/w')).status, 201);
  assert.equal((await request(app).post('/w')).status, 429);
  assert.equal((await request(app).post('/r')).status, 201);
});

test('the bucket resets when the window expires', async () => {
  const clock = createClock();
  const app = buildApp(buildLimiter({ clock, limit: 1, windowSeconds: 60 }));

  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 429);

  clock.value += 59_000;
  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 429);

  clock.value += 1_000;
  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
});

test('keys by user id, sets a TTL, and falls back to IP when no user is attached', async () => {
  const redisClient = createFakeRedis();
  const app = buildApp(buildLimiter({ redisClient, clock: createClock(), action: 'withdrawal' }));

  await request(app).post('/action').set('x-user', 'u-1');
  await request(app).post('/action');

  const keys = [...redisClient.counts.keys()];
  assert.ok(keys.some(k => k.startsWith('rl:fin:withdrawal:user:u-1:')));
  assert.ok(keys.some(k => k.startsWith('rl:fin:withdrawal:ip:')));
});

test('fails open when Redis is unavailable', async () => {
  const handlerCalls = { count: 0 };
  const redisClient = {
    pipeline: () => ({
      incr: () => {},
      expire: () => {},
      exec: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
  };
  const app = buildApp(buildLimiter({ redisClient, limit: 1 }), { handlerCalls });

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
  }
  assert.equal(handlerCalls.count, 3);
});

test('fails open when the INCR command itself errors', async () => {
  const redisClient = {
    pipeline: () => ({
      incr: () => {},
      expire: () => {},
      exec: async () => [
        [new Error('READONLY'), null],
        [null, 1],
      ],
    }),
  };
  const app = buildApp(buildLimiter({ redisClient, limit: 1 }));

  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
});

test('env overrides limit and window; invalid values fall back to defaults', async t => {
  t.after(() => {
    delete process.env.TEST_FIN_ATTEMPT_LIMIT;
    delete process.env.TEST_FIN_ATTEMPT_WINDOW_SECONDS;
  });

  process.env.TEST_FIN_ATTEMPT_LIMIT = '1';
  process.env.TEST_FIN_ATTEMPT_WINDOW_SECONDS = '10';
  const clock = createClock();
  const app = buildApp(buildLimiter({ clock, limit: 5, windowSeconds: 60 }));
  assert.equal((await request(app).post('/action').set('x-user', 'u-1')).status, 201);
  const limited = await request(app).post('/action').set('x-user', 'u-1');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '10');

  process.env.TEST_FIN_ATTEMPT_LIMIT = 'abc';
  process.env.TEST_FIN_ATTEMPT_WINDOW_SECONDS = '-5';
  const fallbackApp = buildApp(buildLimiter({ clock: createClock(), limit: 2, windowSeconds: 60 }));
  assert.equal((await request(fallbackApp).post('/action').set('x-user', 'u-9')).status, 201);
  assert.equal((await request(fallbackApp).post('/action').set('x-user', 'u-9')).status, 201);
  const fallbackLimited = await request(fallbackApp).post('/action').set('x-user', 'u-9');
  assert.equal(fallbackLimited.status, 429);
  assert.equal(fallbackLimited.headers['retry-after'], '60');
});

// ---------------------------------------------------------------------------
// Route wiring
// ---------------------------------------------------------------------------

function authStub(userId = 'creator-1') {
  return {
    requireAuth: (req, res, next) => {
      if (!req.get('authorization')) return res.status(401).json({ error: 'Unauthorized' });
      req.user = { userId, role: 'creator' };
      return next();
    },
    requireRole: () => (_req, _res, next) => next(),
  };
}

test('withdrawal routes: limiter runs after auth and before any database work', async () => {
  const redisClient = createFakeRedis();
  const limiter = buildLimiter({
    redisClient,
    clock: createClock(),
    limit: 2,
    action: 'withdrawal',
  });
  const queries = [];
  const queryImpl = async text => {
    queries.push(text);
    return { rows: [] };
  };

  const router = proxyquire('../routes/withdrawals', {
    '../middleware/financialActionRateLimiter': { withdrawalAttemptLimiter: limiter },
    '../middleware/auth': authStub(),
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release() {} }),
    },
    '../config/logger': silentLogger,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/withdrawals', router);

  const body = {
    campaign_id: '11111111-1111-1111-1111-111111111111',
    destination_key: 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK',
    amount: '10.0000000',
    evidence: [{ type: 'link', url: 'https://example.com/invoice' }],
  };

  // Unauthenticated attempts are rejected by auth and never touch the bucket.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await request(app).post('/api/withdrawals/request').send(body)).status, 401);
  }
  assert.equal(redisClient.counts.size, 0);

  const first = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer t')
    .send(body);
  assert.notEqual(first.status, 429);
  const approve = await request(app)
    .post('/api/withdrawals/w-1/approve/creator')
    .set('Authorization', 'Bearer t');
  assert.notEqual(approve.status, 429);

  const queriesBefore = queries.length;
  const blocked = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer t')
    .send(body);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  const blockedApprove = await request(app)
    .post('/api/withdrawals/w-1/approve/creator')
    .set('Authorization', 'Bearer t');
  assert.equal(blockedApprove.status, 429);
  assert.equal(queries.length, queriesBefore, 'blocked attempts must not reach the database');

  // Reads stay unlimited.
  const read = await request(app)
    .get('/api/withdrawals/campaign/11111111-1111-1111-1111-111111111111')
    .set('Authorization', 'Bearer t');
  assert.notEqual(read.status, 429);
});

test('refund request routes: create and pay are limited; review and reads are not', async () => {
  const limiter = buildLimiter({ clock: createClock(), limit: 2, action: 'refund' });
  const calls = { create: 0, pay: 0, review: 0, get: 0 };
  const router = proxyquire('../routes/refundRequests', {
    '../middleware/financialActionRateLimiter': { refundAttemptLimiter: limiter },
    '../middleware/auth': authStub('backer-1'),
    '../services/refundRequestService': {
      createRequest: async () => {
        calls.create += 1;
        return { id: 'rr-1', status: 'pending' };
      },
      payRequest: async () => {
        calls.pay += 1;
        return { id: 'rr-1', status: 'paid' };
      },
      reviewRequest: async () => {
        calls.review += 1;
        return { id: 'rr-1', status: 'approved' };
      },
      getRequest: async () => {
        calls.get += 1;
        return { id: 'rr-1' };
      },
      listRequests: async () => [],
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/refund-requests', router);
  const auth = r => r.set('Authorization', 'Bearer t');

  assert.equal((await auth(request(app).post('/api/refund-requests')).send({})).status, 201);
  assert.equal((await auth(request(app).post('/api/refund-requests/rr-1/pay'))).status, 200);
  assert.equal((await auth(request(app).post('/api/refund-requests')).send({})).status, 429);
  assert.equal((await auth(request(app).post('/api/refund-requests/rr-1/pay'))).status, 429);
  assert.deepEqual([calls.create, calls.pay], [1, 1]);

  for (let i = 0; i < 3; i += 1) {
    const review = await auth(request(app).post('/api/refund-requests/rr-1/review')).send({
      approve: true,
    });
    assert.equal(review.status, 200);
    assert.equal((await auth(request(app).get('/api/refund-requests/rr-1'))).status, 200);
  }
  assert.equal(calls.review, 3);
});

test('campaign direct refund route runs the refund limiter right after requireAuth', () => {
  const realLimiters = require('./financialActionRateLimiter');
  const campaigns = require('../routes/campaigns');
  const layer = campaigns.stack.find(
    l => l.route && l.route.path === '/:id/refunds' && l.route.methods.post
  );
  assert.ok(layer, 'POST /:id/refunds route exists');
  const handlers = layer.route.stack.map(s => s.handle);
  assert.equal(layer.route.stack[0].name, 'requireAuth');
  assert.equal(handlers[1], realLimiters.refundAttemptLimiter);

  const getLayer = campaigns.stack.find(
    l => l.route && l.route.path === '/:id/refunds' && l.route.methods.get
  );
  assert.ok(!getLayer.route.stack.some(s => s.handle === realLimiters.refundAttemptLimiter));
});
