'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createVelocityLimit } = require('./velocityLimit');

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

function buildApp({ count = 0, query, kind = 'withdrawal', env } = {}) {
  const limiter = createVelocityLimit({
    kind,
    actorId: req => req.user?.userId,
    query: query || (async () => ({ rows: [{ count }] })),
    env: env || {},
    logger: silentLogger,
    now: () => new Date('2026-01-01T12:00:00.000Z'),
  });

  const app = express();
  app.use((req, _res, next) => {
    req.user = { userId: 'user-1' };
    next();
  });
  app.post('/api/withdrawals/request', limiter, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.use((_err, _req, res, _next) => {
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

test('velocity limiter allows requests below the limit', async () => {
  const app = buildApp({ count: 1, env: { WITHDRAWAL_VELOCITY_MAX_REQUESTS: '5' } });

  const res = await request(app).post('/api/withdrawals/request').send({});

  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
});

test('velocity limiter returns 429 with Retry-After when the limit is reached', async () => {
  const app = buildApp({ count: 5, env: { WITHDRAWAL_VELOCITY_MAX_REQUESTS: '5' } });

  const res = await request(app).post('/api/withdrawals/request').send({});

  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], String(60 * 60));
  assert.equal(res.body.error, 'Too Many Requests');
  assert.equal(res.body.code, 'VELOCITY_LIMIT_EXCEEDED');
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.retry_after, 60 * 60);
});

test('velocity limiter uses the refund table and label for refund attempts', async () => {
  const calls = [];
  const app = buildApp({
    kind: 'refund',
    env: { REFUND_VELOCITY_MAX_REQUESTS: '2' },
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ count: 2 }] };
    },
  });

  const res = await request(app).post('/api/withdrawals/request').send({});

  assert.equal(res.status, 429);
  assert.match(res.body.message, /Refund velocity limit exceeded/);
  assert.match(calls[0].text, /FROM refund_requests/);
  assert.equal(calls[0].params[0], 'user-1');
});

test('velocity limiter forwards unexpected database errors to next(err)', async () => {
  const app = buildApp({
    query: async () => {
      throw new Error('database unavailable');
    },
  });

  const res = await request(app).post('/api/withdrawals/request').send({});

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'internal');
});
