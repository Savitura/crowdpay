const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, user = { userId: 'user-1', role: 'contributor' } } = {}) {
  const service = proxyquire('../services/categoryFollowService', {
    '../config/database': { query: queryImpl },
  });
  const router = proxyquire('./categoryFollows', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        if (!user) return _res.status(401).json({ error: 'Unauthorized' });
        req.user = user;
        next();
      },
      optionalAuth: (req, _res, next) => {
        if (user) req.user = user;
        next();
      },
    },
    '../services/categoryFollowService': service,
    '../services/auditService': { logAuditEvent: async () => ({}) },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

test('GET /api/categories is public and marks following state', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('unnest($1::text[])')) {
        return {
          rows: [
            { category: 'arts', follower_count: 2, active_campaigns: 5 },
            { category: 'technology', follower_count: 0, active_campaigns: 1 },
          ],
        };
      }
      if (text.includes('FROM category_follows WHERE user_id')) {
        assert.deepEqual(params, ['user-1']);
        return { rows: [{ category: 'arts' }] };
      }
      return { rows: [] };
    },
  });
  const res = await request(app).get('/api/categories');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    { category: 'arts', follower_count: 2, active_campaigns: 5, following: true },
    { category: 'technology', follower_count: 0, active_campaigns: 1, following: false },
  ]);
  assert.match(res.headers['cache-control'], /max-age=60/);
});

test('POST /api/users/me/category-follows creates with 201', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.startsWith('INSERT INTO category_follows')) {
        return { rows: [{ category: 'arts', created_at: '2026-09-30T00:00:00.000Z' }] };
      }
      return { rows: [] };
    },
  });
  const res = await request(app).post('/api/users/me/category-follows').send({ category: 'arts' });
  assert.equal(res.status, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.category, 'arts');
});

test('POST duplicate follow returns 200 with created:false (deterministic)', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.startsWith('INSERT INTO category_follows')) return { rows: [] };
      return { rows: [{ category: 'health', created_at: '2026-09-01T00:00:00.000Z' }] };
    },
  });
  const res = await request(app)
    .post('/api/users/me/category-follows')
    .send({ category: 'health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, false);
  assert.equal(res.body.following, true);
});

test('POST rejects invalid category with VALIDATION_ERROR envelope', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
  const res = await request(app).post('/api/users/me/category-follows').send({ category: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('POST without category returns 400, without auth returns 401', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
  const missing = await request(app).post('/api/users/me/category-follows').send({});
  assert.equal(missing.status, 400);

  const anon = buildApp({ queryImpl: async () => ({ rows: [] }), user: null });
  const unauth = await request(anon)
    .post('/api/users/me/category-follows')
    .send({ category: 'arts' });
  assert.equal(unauth.status, 401);
});

test('DELETE unfollow is idempotent 204 even when not following', async () => {
  const calls = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      calls.push({ text, params });
      return { rowCount: 0 };
    },
  });
  const res = await request(app).delete('/api/users/me/category-follows/arts');
  assert.equal(res.status, 204);
  const del = calls.find(c => c.text.startsWith('DELETE FROM category_follows'));
  assert.deepEqual(del.params, ['user-1', 'arts']);
});

test('DELETE rejects invalid category and requires auth', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
  const bad = await request(app).delete('/api/users/me/category-follows/bogus');
  assert.equal(bad.status, 400);

  const anon = buildApp({ queryImpl: async () => ({ rows: [] }), user: null });
  const unauth = await request(anon).delete('/api/users/me/category-follows/arts');
  assert.equal(unauth.status, 401);
});

test('GET /api/users/me/category-follows is scoped to the current user', async () => {
  const calls = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ category: 'arts', followed_at: '2026-09-01T00:00:00.000Z' }] };
    },
    user: { userId: 'user-7', role: 'contributor' },
  });
  const res = await request(app).get('/api/users/me/category-follows');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ category: 'arts', followed_at: '2026-09-01T00:00:00.000Z' }]);
  assert.deepEqual(calls[0].params, ['user-7']);
});

test('category matching is case-insensitive on write paths', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.startsWith('INSERT INTO category_follows')) {
        return { rows: [{ category: 'arts', created_at: '2026-09-30T00:00:00.000Z' }] };
      }
      return { rows: [] };
    },
  });
  const res = await request(app)
    .post('/api/users/me/category-follows')
    .send({ category: '  ARTS ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.category, 'arts');
});
