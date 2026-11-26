const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadErrorHandler() {
  const logged = [];
  const logger = {
    error: (...args) => logged.push(args),
    warn: (...args) => logged.push(args),
    info: (...args) => logged.push(args),
  };
  const mod = proxyquire('./errorHandler', { '../config/logger': logger });
  return { ...mod, logged };
}

function mockRes(statusCode = 200) {
  return {
    statusCode,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('normalizeErrorResponse wraps a string error in a stable error object', () => {
  const { normalizeErrorResponse } = loadErrorHandler();
  const res = mockRes(404);

  normalizeErrorResponse({}, res, () => {});
  res.json({ error: 'Campaign not found' });

  assert.equal(res.body.error.code, 'ERROR');
  assert.equal(res.body.error.message, 'Campaign not found');
});

test('normalizeErrorResponse preserves fields from an object error without a code', () => {
  const { normalizeErrorResponse } = loadErrorHandler();
  const res = mockRes(400);

  normalizeErrorResponse({}, res, () => {});
  res.json({ error: { message: 'Invalid amount', fields: { amount: 'must be positive' } } });

  assert.deepEqual(res.body, {
    error: {
      code: 'ERROR',
      message: 'Invalid amount',
      fields: { amount: 'must be positive' },
    },
  });
});

test('normalizeErrorResponse leaves errors that already have a code untouched', () => {
  const { normalizeErrorResponse } = loadErrorHandler();
  const res = mockRes(409);
  const payload = { error: { code: 'DUPLICATE_EMAIL', message: 'Email already registered' } };

  normalizeErrorResponse({}, res, () => {});
  res.json(payload);

  assert.deepEqual(res.body, payload);
});

test('normalizeErrorResponse does not rewrite successful responses', () => {
  const { normalizeErrorResponse } = loadErrorHandler();
  const res = mockRes(200);
  const payload = { error: 'this key is legal data on a 200 response' };

  normalizeErrorResponse({}, res, () => {});
  res.json(payload);

  assert.deepEqual(res.body, payload);
});

test('errorHandler normalizes validation failures to 422 VALIDATION_ERROR', () => {
  const { errorHandler } = loadErrorHandler();
  const res = mockRes();
  const err = Object.assign(new Error('email is required'), {
    status: 422,
    fields: { email: 'required' },
  });

  errorHandler(err, {}, res, () => {});

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'email is required',
      fields: { email: 'required' },
    },
  });
});

test('errorHandler keeps explicit status codes and error codes', () => {
  const { errorHandler } = loadErrorHandler();
  const res = mockRes();
  const err = Object.assign(new Error('Campaign is closed'), {
    statusCode: 409,
    code: 'CAMPAIGN_CLOSED',
  });

  errorHandler(err, {}, res, () => {});

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: { code: 'CAMPAIGN_CLOSED', message: 'Campaign is closed' },
  });
});

test('errorHandler defaults unknown errors to 500 INTERNAL_ERROR', () => {
  const { errorHandler } = loadErrorHandler();
  const res = mockRes();

  errorHandler(new Error('boom'), {}, res, () => {});

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'boom' } });
});

test('errorHandler hides server error messages and stacks in production', t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    process.env.NODE_ENV = previous;
  });

  const { errorHandler, logged } = loadErrorHandler();
  const res = mockRes();
  const err = new Error('connection string postgres://user:pass@db failed');
  err.stack = 'Error: connection string postgres://user:pass@db failed\n    at db.js:1:1';

  errorHandler(err, {}, res, () => {});

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
  assert.equal(logged.length, 1);
  const [, meta] = logged[0];
  assert.equal(meta.stack, undefined, 'production logs must not include stack traces');
  assert.equal(JSON.stringify(res.body).includes('postgres://'), false);
});

test('errorHandler logs the message and stack outside production', t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  t.after(() => {
    process.env.NODE_ENV = previous;
  });

  const { errorHandler, logged } = loadErrorHandler();
  const res = mockRes();
  const err = new Error('debug me');

  errorHandler(err, {}, res, () => {});

  assert.equal(res.body.error.message, 'debug me');
  assert.equal(logged.length, 1);
  const [message, meta] = logged[0];
  assert.equal(message, 'Unhandled request error');
  assert.equal(meta.error, 'debug me');
  assert.match(meta.stack, /debug me/);
});
