const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({
  query = async () => ({ rows: [] }),
  role = 'contributor',
  authenticated = true,
} = {}) {
  const router = proxyquire('./campaignTemplates', {
    '../config/database': { query },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (!authenticated) return res.status(401).json({ error: 'Authentication required' });
        req.user = { userId: 'admin-1', role };
        next();
      },
      requireAdmin: (req, res, next) => {
        if (req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Admin access required' });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/templates', router);
  return app;
}

test('public template listing shows only active templates ordered by name', async () => {
  const queries = [];
  const rows = [
    { id: 'template-1', slug: 'alpha', name: 'Alpha', is_active: true },
    { id: 'template-2', slug: 'beta', name: 'Beta', is_active: true },
  ];
  const app = buildApp({
    query: async text => {
      queries.push(text);
      return { rows };
    },
  });

  const res = await request(app).get('/api/templates');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
  assert.match(queries[0], /WHERE is_active = TRUE/);
  assert.match(queries[0], /ORDER BY name/);
});

test('admin template routes reject anonymous and non-admin callers before querying', async () => {
  let queryCalls = 0;
  const countQuery = async () => {
    queryCalls += 1;
    return { rows: [] };
  };
  const anonymous = buildApp({ authenticated: false, query: countQuery });
  const contributor = buildApp({ role: 'contributor', query: countQuery });

  assert.equal((await request(anonymous).get('/api/templates/admin')).status, 401);
  assert.equal((await request(contributor).get('/api/templates/admin')).status, 403);
  assert.equal(
    (
      await request(contributor).post('/api/templates/admin').send({
        slug: 'alpha',
        name: 'Alpha',
        category: 'arts',
        description: 'd',
        template_data: {},
      })
    ).status,
    403
  );
  assert.equal((await request(contributor).delete('/api/templates/admin/template-1')).status, 403);
  assert.equal(queryCalls, 0);
});

test('admin listing includes inactive templates', async () => {
  const queries = [];
  const rows = [
    { id: 'template-1', name: 'Alpha', is_active: true },
    { id: 'template-2', name: 'Beta', is_active: false },
  ];
  const app = buildApp({
    role: 'admin',
    query: async text => {
      queries.push(text);
      return { rows };
    },
  });

  const res = await request(app).get('/api/templates/admin');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
  assert.equal(queries[0].includes('is_active = TRUE'), false);
  assert.match(queries[0], /ORDER BY name/);
});

test('admin template create validates fields and defaults to active', async () => {
  const calls = [];
  const app = buildApp({
    role: 'admin',
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ id: 'template-1' }] };
    },
  });

  const invalid = await request(app)
    .post('/api/templates/admin')
    .send({ slug: 'alpha', name: 'Alpha', category: 'arts', description: 'd' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /template_data are required/);
  assert.equal(calls.length, 0);

  const template_data = { title: 'Alpha' };
  const valid = await request(app)
    .post('/api/templates/admin')
    .send({ slug: 'alpha', name: 'Alpha', category: 'arts', description: 'd', template_data });
  assert.equal(valid.status, 201);
  assert.deepEqual(calls[0].params, ['alpha', 'Alpha', 'arts', 'd', template_data, true]);
});

test('admin delete soft-deletes a template and hides it from the public listing', async () => {
  const templates = [
    { id: 'template-1', slug: 'alpha', name: 'Alpha', is_active: true },
    { id: 'template-2', slug: 'beta', name: 'Beta', is_active: true },
  ];
  const app = buildApp({
    role: 'admin',
    query: async (text, params) => {
      if (text.includes('WHERE is_active = TRUE')) {
        return {
          rows: templates
            .filter(template => template.is_active)
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      }
      if (text.includes('SET is_active = FALSE')) {
        const template = templates.find(item => item.id === params[0]);
        if (!template) return { rows: [] };
        template.is_active = false;
        return { rows: [{ id: template.id }] };
      }
      return { rows: [] };
    },
  });

  const before = await request(app).get('/api/templates');
  assert.deepEqual(
    before.body.map(template => template.id),
    ['template-1', 'template-2']
  );

  const removed = await request(app).delete('/api/templates/admin/template-1');
  assert.equal(removed.status, 204);

  const after = await request(app).get('/api/templates');
  assert.deepEqual(
    after.body.map(template => template.id),
    ['template-2']
  );

  const missing = await request(app).delete('/api/templates/admin/not-found');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Template not found' });
});
