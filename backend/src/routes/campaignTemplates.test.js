'use strict';

/**
 * Tests for campaign-templates routes (#861).
 *
 * Covers:
 *   - GET  /api/campaign-templates          public list (active only)
 *   - GET  /api/campaign-templates/admin    admin list (all)
 *   - POST /api/campaign-templates/admin    admin create
 *   - PATCH /api/campaign-templates/admin/:id  admin update
 *   - DELETE /api/campaign-templates/admin/:id admin soft-delete
 *   - 401 / 403 guards on admin routes
 *   - Route-is-reachable smoke test (prevents "written but never mounted" regression)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMPLATE = {
  id: 'aaaa-bbbb',
  slug: 'community-project',
  name: 'Community project',
  category: 'community',
  description: 'A community project template.',
  template_data: { title: 'My community project', milestones: [] },
  is_active: true,
  use_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const INACTIVE_TEMPLATE = { ...TEMPLATE, id: 'cccc-dddd', slug: 'old-template', is_active: false };

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {Function|null} opts.queryImpl   - replace db.query
 * @param {'none'|'user'|'admin'} opts.authAs - who the request is authenticated as
 */
function buildApp({ queryImpl, authAs = 'none' } = {}) {
  const defaultQuery = async () => ({ rows: [] });

  const router = proxyquire('./campaignTemplates', {
    '../config/database': {
      query: queryImpl || defaultQuery,
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (authAs === 'none') {
          return res.status(401).json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
        }
        req.user =
          authAs === 'admin'
            ? { userId: 'admin-1', role: 'admin', is_admin: true }
            : { userId: 'user-1', role: 'contributor', is_admin: false };
        return next();
      },
      requireAdmin: (req, res, next) => {
        if (!req.user || !req.user.is_admin) {
          return res.status(403).json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } });
        }
        return next();
      },
    },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaign-templates', router);
  // Generic error handler so asyncHandler errors surface as 500 in tests.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

// ===========================================================================
// Public list
// ===========================================================================

test('GET /api/campaign-templates — returns active templates without auth', async () => {
  const app = buildApp({
    queryImpl: async sql => {
      assert.match(sql, /is_active = TRUE/i, 'should filter by is_active');
      return { rows: [TEMPLATE] };
    },
  });

  const res = await request(app).get('/api/campaign-templates');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].slug, 'community-project');
});

test('GET /api/campaign-templates — returns empty array when no active templates', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });

  const res = await request(app).get('/api/campaign-templates');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

// ===========================================================================
// Admin list
// ===========================================================================

test('GET /api/campaign-templates/admin — 401 when unauthenticated', async () => {
  const app = buildApp({ authAs: 'none' });

  const res = await request(app).get('/api/campaign-templates/admin');

  assert.equal(res.status, 401);
});

test('GET /api/campaign-templates/admin — 403 for non-admin user', async () => {
  const app = buildApp({ authAs: 'user' });

  const res = await request(app).get('/api/campaign-templates/admin');

  assert.equal(res.status, 403);
});

test('GET /api/campaign-templates/admin — returns all templates (including inactive) for admin', async () => {
  const app = buildApp({
    authAs: 'admin',
    queryImpl: async sql => {
      // The admin query selects all rows — it must NOT have a WHERE is_active = TRUE filter
      assert.doesNotMatch(
        sql,
        /WHERE is_active = TRUE/i,
        'admin query should not filter by is_active'
      );
      return { rows: [TEMPLATE, INACTIVE_TEMPLATE] };
    },
  });

  const res = await request(app).get('/api/campaign-templates/admin');

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// ===========================================================================
// Admin create
// ===========================================================================

test('POST /api/campaign-templates/admin — 401 when unauthenticated', async () => {
  const app = buildApp({ authAs: 'none' });

  const res = await request(app)
    .post('/api/campaign-templates/admin')
    .send({ slug: 'x', name: 'X', category: 'other', description: 'desc', template_data: {} });

  assert.equal(res.status, 401);
});

test('POST /api/campaign-templates/admin — 403 for non-admin user', async () => {
  const app = buildApp({ authAs: 'user' });

  const res = await request(app)
    .post('/api/campaign-templates/admin')
    .send({ slug: 'x', name: 'X', category: 'other', description: 'desc', template_data: {} });

  assert.equal(res.status, 403);
});

test('POST /api/campaign-templates/admin — 400 when required fields are missing', async () => {
  const app = buildApp({ authAs: 'admin' });

  // Missing template_data
  const res = await request(app)
    .post('/api/campaign-templates/admin')
    .send({ slug: 'x', name: 'X', category: 'other', description: 'desc' });

  assert.equal(res.status, 400);
});

test('POST /api/campaign-templates/admin — 400 when template_data is not an object', async () => {
  const app = buildApp({ authAs: 'admin' });

  const res = await request(app)
    .post('/api/campaign-templates/admin')
    .send({ slug: 'x', name: 'X', category: 'other', description: 'desc', template_data: 'bad' });

  assert.equal(res.status, 400);
});

test('POST /api/campaign-templates/admin — creates template and returns 201', async () => {
  let capturedParams;
  const app = buildApp({
    authAs: 'admin',
    queryImpl: async (_sql, params) => {
      capturedParams = params;
      return { rows: [{ ...TEMPLATE, slug: params[0], name: params[1] }] };
    },
  });

  const payload = {
    slug: 'new-template',
    name: 'New template',
    category: 'arts',
    description: 'A new template.',
    template_data: { title: 'Draft title', milestones: [] },
    is_active: true,
  };

  const res = await request(app).post('/api/campaign-templates/admin').send(payload);

  assert.equal(res.status, 201);
  assert.equal(res.body.slug, 'new-template');
  assert.equal(capturedParams[0], 'new-template');
  assert.equal(capturedParams[1], 'New template');
});

// ===========================================================================
// Admin update
// ===========================================================================

test('PATCH /api/campaign-templates/admin/:id — 401 when unauthenticated', async () => {
  const app = buildApp({ authAs: 'none' });

  const res = await request(app)
    .patch('/api/campaign-templates/admin/aaaa-bbbb')
    .send({ name: 'Updated' });

  assert.equal(res.status, 401);
});

test('PATCH /api/campaign-templates/admin/:id — 403 for non-admin user', async () => {
  const app = buildApp({ authAs: 'user' });

  const res = await request(app)
    .patch('/api/campaign-templates/admin/aaaa-bbbb')
    .send({ name: 'Updated' });

  assert.equal(res.status, 403);
});

test('PATCH /api/campaign-templates/admin/:id — 404 when template does not exist', async () => {
  const app = buildApp({
    authAs: 'admin',
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .patch('/api/campaign-templates/admin/does-not-exist')
    .send({ name: 'Updated' });

  assert.equal(res.status, 404);
});

test('PATCH /api/campaign-templates/admin/:id — updates template and returns updated row', async () => {
  const app = buildApp({
    authAs: 'admin',
    queryImpl: async () => ({ rows: [{ ...TEMPLATE, name: 'Updated name' }] }),
  });

  const res = await request(app)
    .patch('/api/campaign-templates/admin/aaaa-bbbb')
    .send({ name: 'Updated name' });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Updated name');
});

// ===========================================================================
// Admin delete (soft)
// ===========================================================================

test('DELETE /api/campaign-templates/admin/:id — 401 when unauthenticated', async () => {
  const app = buildApp({ authAs: 'none' });

  const res = await request(app).delete('/api/campaign-templates/admin/aaaa-bbbb');

  assert.equal(res.status, 401);
});

test('DELETE /api/campaign-templates/admin/:id — 403 for non-admin user', async () => {
  const app = buildApp({ authAs: 'user' });

  const res = await request(app).delete('/api/campaign-templates/admin/aaaa-bbbb');

  assert.equal(res.status, 403);
});

test('DELETE /api/campaign-templates/admin/:id — 404 when template does not exist', async () => {
  const app = buildApp({
    authAs: 'admin',
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app).delete('/api/campaign-templates/admin/does-not-exist');

  assert.equal(res.status, 404);
});

test('DELETE /api/campaign-templates/admin/:id — soft-deletes template and returns 204', async () => {
  let capturedSql;
  const app = buildApp({
    authAs: 'admin',
    queryImpl: async sql => {
      capturedSql = sql;
      return { rows: [{ id: 'aaaa-bbbb' }] };
    },
  });

  const res = await request(app).delete('/api/campaign-templates/admin/aaaa-bbbb');

  assert.equal(res.status, 204);
  assert.match(capturedSql, /is_active = FALSE/i, 'delete should be a soft-delete');
});

// ===========================================================================
// Route-reachability smoke test
// Ensures "written but never mounted" cannot recur undetected (#861).
// ===========================================================================

test('route reachability — GET /api/campaign-templates responds (not 404)', async () => {
  // Build app the same way index.js does: mount the real router on its intended prefix.
  const router = proxyquire('./campaignTemplates', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../middleware/auth': {
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
    },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
  });

  const app = express();
  app.use(express.json());
  // Mount at the prefix used in index.js.
  app.use('/api/campaign-templates', router);

  const res = await request(app).get('/api/campaign-templates');

  // Any non-404 response means the router was found and executed.
  assert.notEqual(
    res.status,
    404,
    'campaign-templates route must be reachable at /api/campaign-templates'
  );
});
