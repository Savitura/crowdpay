const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  // Mount the router directly under /api/dev
  app.use('/api/dev', require('./dev'));
  return app;
}

test('dev routes are disabled outside of development environment', async t => {
  const originalEnv = process.env.NODE_ENV;

  await t.test('returns 404 when NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const app = buildTestApp();
    const res = await request(app).get('/api/dev/emails');
    assert.equal(res.status, 404);
  });

  await t.test('returns 404 when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildTestApp();
    const res = await request(app).get('/api/dev/emails');
    assert.equal(res.status, 404);
  });

  process.env.NODE_ENV = originalEnv;
});

test('dev routes operate properly when NODE_ENV=development', async t => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const app = buildTestApp();

  t.after(() => {
    process.env.NODE_ENV = originalEnv;
  });

  await t.test('GET /api/dev/emails returns JSON list of templates', async () => {
    const res = await request(app).get('/api/dev/emails');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.templates));
    assert.ok(res.body.templates.length > 0);

    const welcomeTemplate = res.body.templates.find(tmpl => tmpl.name === 'welcome');
    assert.ok(welcomeTemplate, 'welcome template should be present in listing');
    assert.ok(welcomeTemplate.methods.includes('build'));

    // layout.js is an internal helper and must not be listed as a template
    const layout = res.body.templates.find(tmpl => tmpl.name === 'layout');
    assert.equal(layout, undefined, 'layout.js should be excluded');
  });

  await t.test('GET /api/dev/emails renders HTML catalog when Accept: text/html', async () => {
    const res = await request(app).get('/api/dev/emails').set('Accept', 'text/html');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /html/);
    assert.ok(res.text.includes('DEVELOPMENT ONLY'));
    assert.ok(res.text.includes('Email Templates Preview'));
  });

  await t.test('GET /api/dev/emails/:templateName renders HTML email preview', async () => {
    const res = await request(app).get('/api/dev/emails/welcome');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /html/);
    assert.ok(res.text.includes('Welcome, Alex Johnson!'));
  });

  await t.test('GET /api/dev/emails/:templateName?format=json returns JSON payload', async () => {
    const res = await request(app).get('/api/dev/emails/welcome?format=json');
    assert.equal(res.status, 200);
    assert.equal(res.body.subject, 'Welcome to CrowdPay');
    assert.ok(res.body.text.includes('Welcome to CrowdPay!'));
    assert.ok(res.body.html.includes('Welcome, Alex Johnson!'));
  });

  await t.test('GET /api/dev/emails/:templateName accepts query parameter overrides', async () => {
    const res = await request(app).get('/api/dev/emails/welcome?name=Tunde&format=json');
    assert.equal(res.status, 200);
    assert.ok(res.body.html.includes('Welcome, Tunde!'));
  });

  await t.test('GET /api/dev/emails/:templateName rejects invalid template names', async () => {
    const res = await request(app).get('/api/dev/emails/..%2F..%2Fpackage');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid template name');
  });

  await t.test(
    'GET /api/dev/emails/:templateName returns 404 for non-existent template',
    async () => {
      const res = await request(app).get('/api/dev/emails/non_existent_email_template');
      assert.equal(res.status, 404);
      assert.ok(res.body.error.includes('not found'));
    }
  );
});

test('dev route is mounted conditionally in index.js only when NODE_ENV === development', () => {
  const fs = require('fs');
  const path = require('path');
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

  assert.ok(
    indexSource.includes("process.env.NODE_ENV === 'development'"),
    'index.js must check for development environment'
  );
  assert.ok(
    indexSource.includes("app.use('/api/dev', require('./routes/dev'))"),
    'index.js must mount /api/dev conditionally'
  );
});
