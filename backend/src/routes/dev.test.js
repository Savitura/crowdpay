const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const devRouter = require('./dev');

function buildApp() {
  const app = express();
  app.use('/api/v1/dev', devRouter);
  return app;
}

test('all dev routes are blocked in production', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const app = buildApp();

    const index = await request(app).get('/api/v1/dev/email-preview');
    assert.equal(index.status, 403);
    assert.equal(index.text, 'Not allowed in production');

    const template = await request(app).get('/api/v1/dev/email-preview/thankYou');
    assert.equal(template.status, 403);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('GET /api/v1/dev/email-preview lists built-in email templates', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = buildApp();

    const res = await request(app).get('/api/v1/dev/email-preview');

    assert.equal(res.status, 200);
    assert.match(res.text, /Email Templates/);
    assert.match(res.text, /thankYou/);
    assert.match(res.text, /welcome/);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('GET /api/v1/dev/email-preview/:templateName renders an email template', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = buildApp();

    const res = await request(app).get('/api/v1/dev/email-preview/thankYou');

    assert.equal(res.status, 200);
    assert.match(res.text, /thank-you/i);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('GET /api/v1/dev/email-preview/:templateName supports explicit _method', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = buildApp();

    const res = await request(app).get('/api/v1/dev/email-preview/thankYou?_method=build');

    assert.equal(res.status, 200);
    assert.match(res.text, /thank-you/i);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('GET /api/v1/dev/email-preview/:templateName returns 404 for unknown template', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = buildApp();

    const res = await request(app).get('/api/v1/dev/email-preview/doesNotExist');

    assert.equal(res.status, 404);
    assert.match(res.text, /not found/i);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('GET /api/v1/dev/email-preview/:templateName rejects unsafe template names', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = buildApp();

    const res = await request(app).get('/api/v1/dev/email-preview/Bad%21Name');

    assert.equal(res.status, 400);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('GET /api/v1/dev/email-preview/:templateName returns 400 for unknown method', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const app = buildApp();

    const res = await request(app).get(
      '/api/v1/dev/email-preview/thankYou?_method=send',
    );

    assert.equal(res.status, 400);
    assert.match(res.text, /Method "send" not found/);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});