const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { requestIdMiddleware } = require('./requestId');
const { getRequestContext } = require('../config/requestContext');

test('requestIdMiddleware generates X-Request-ID header when not provided', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/test', (req, res) => {
    res.json({ requestId: req.id });
  });

  const response = await request(app).get('/test');
  assert.equal(response.status, 200);
  assert.ok(response.headers['x-request-id']);
  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  assert.equal(response.body.requestId, response.headers['x-request-id']);
});

test('requestIdMiddleware echoes provided X-Request-ID header', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/test', (req, res) => {
    res.json({ requestId: req.id });
  });

  const customRequestId = 'custom-request-id-123';
  const response = await request(app).get('/test').set('X-Request-ID', customRequestId);
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-request-id'], customRequestId);
  assert.equal(response.body.requestId, customRequestId);
});

test('requestIdMiddleware populates AsyncLocalStorage context', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/test', (req, res) => {
    const ctx = getRequestContext();
    res.json({ contextRequestId: ctx.requestId });
  });

  const response = await request(app).get('/test');
  assert.equal(response.status, 200);
  assert.ok(response.body.contextRequestId);
  assert.equal(response.body.contextRequestId, response.headers['x-request-id']);
});

test('requestIdMiddleware works on error responses', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/error', (_req, _res, next) => {
    next(new Error('Test error'));
  });
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  const response = await request(app).get('/error');
  assert.equal(response.status, 500);
  assert.ok(response.headers['x-request-id']);
  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});
