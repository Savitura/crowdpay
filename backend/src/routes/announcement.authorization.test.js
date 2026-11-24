const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const ANNOUNCEMENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function buildApp({
  query = async () => ({ rows: [] }),
  role = 'contributor',
  authenticated = true,
} = {}) {
  const router = proxyquire('./announcement', {
    '../config/database': { query },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!authenticated) return res.status(401).json({ error: 'Authentication required' });
        req.user = { userId: 'admin-1', id: 'admin-1', role };
        next();
      },
      requireRole: required => (req, res, next) => {
        if (req.user?.role !== required) {
          return res.status(403).json({ error: `${required} access required` });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

test('announcement create and deactivate require authentication before touching the database', async () => {
  let queryCalls = 0;
  const app = buildApp({
    authenticated: false,
    query: async () => {
      queryCalls += 1;
      return { rows: [] };
    },
  });

  const anonymousCreate = await request(app)
    .post('/api/announcements/create')
    .send({ message: 'Scheduled maintenance' });
  assert.equal(anonymousCreate.status, 401);

  const contributorApp = buildApp({
    role: 'contributor',
    query: async () => {
      queryCalls += 1;
      return { rows: [] };
    },
  });
  const forbiddenCreate = await request(contributorApp)
    .post('/api/announcements/create')
    .send({ message: 'Scheduled maintenance' });
  assert.equal(forbiddenCreate.status, 403);

  const forbiddenDeactivate = await request(contributorApp).patch(
    `/api/announcements/${ANNOUNCEMENT_ID}/deactivate`
  );
  assert.equal(forbiddenDeactivate.status, 403);
  assert.equal(queryCalls, 0);
});

test('admin announcement create persists defaults and returns 201', async () => {
  const calls = [];
  const created = {
    id: ANNOUNCEMENT_ID,
    message: 'Scheduled maintenance',
    severity: 'info',
    created_by: 'admin-1',
  };
  const app = buildApp({
    role: 'admin',
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [created] };
    },
  });

  const res = await request(app)
    .post('/api/announcements/create')
    .send({ message: '  Scheduled maintenance  ', details_url: 'https://status.example.test' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, created);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /COALESCE\(\$2, 'info'\)/);
  assert.deepEqual(calls[0].params, [
    'Scheduled maintenance',
    undefined,
    'https://status.example.test',
    undefined,
    undefined,
    'admin-1',
  ]);
});

test('announcement create validates fields before the admin insert', async () => {
  let queryCalls = 0;
  const app = buildApp({
    role: 'admin',
    query: async () => {
      queryCalls += 1;
      return { rows: [] };
    },
  });

  const invalid = await request(app)
    .post('/api/announcements/create')
    .send({ message: 'Maintenance', severity: 'panic', details_url: 'not-a-url' });

  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(invalid.body.error.fields.map(field => field.field).sort(), [
    'details_url',
    'severity',
  ]);
  assert.equal(queryCalls, 0);
});

test('admin deactivate updates only active announcements and returns 404 when none match', async () => {
  const calls = [];
  let rows = [];
  const app = buildApp({
    role: 'admin',
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows };
    },
  });

  rows = [{ id: ANNOUNCEMENT_ID, deactivated_at: '2026-01-01T00:00:00Z' }];
  const ok = await request(app).patch(`/api/announcements/${ANNOUNCEMENT_ID}/deactivate`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, ANNOUNCEMENT_ID);
  assert.match(calls[0].text, /deactivated_at IS NULL/);
  assert.deepEqual(calls[0].params, [ANNOUNCEMENT_ID]);

  rows = [];
  const missing = await request(app).patch(`/api/announcements/${ANNOUNCEMENT_ID}/deactivate`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Announcement not found or already deactivated' });
});

test('deactivate rejects a non-UUID id before the database update', async () => {
  let queryCalls = 0;
  const app = buildApp({
    role: 'admin',
    query: async () => {
      queryCalls += 1;
      return { rows: [] };
    },
  });

  const res = await request(app).patch('/api/announcements/not-a-uuid/deactivate');

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /valid UUID/);
  assert.equal(queryCalls, 0);
});

test('GET /api/announcements/active is public and filters the active window', async () => {
  const calls = [];
  const active = [{ id: ANNOUNCEMENT_ID, message: 'Currently active' }];
  const app = buildApp({
    authenticated: false,
    query: async text => {
      calls.push(text);
      return { rows: active };
    },
  });

  const res = await request(app).get('/api/announcements/active');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, active);
  assert.match(calls[0], /active_from <= NOW\(\)/);
  assert.match(calls[0], /deactivated_at IS NULL/);
  assert.match(calls[0], /active_until IS NULL/);
  assert.match(calls[0], /ORDER BY active_from DESC/);
});
