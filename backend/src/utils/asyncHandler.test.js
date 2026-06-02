const test = require('node:test');
const assert = require('node:assert/strict');
const asyncHandler = require('./asyncHandler');

test('asyncHandler passes (req, res, next) to the wrapped function', async () => {
  const req = {};
  const res = {};
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  const handler = asyncHandler(async (r, s, n) => {
    assert.equal(r, req);
    assert.equal(s, res);
    assert.equal(n, next);
  });

  await handler(req, res, next);
  assert.equal(nextCalled, false, 'next should not be called for a successful handler');
});

test('asyncHandler forwards a thrown error to next()', async () => {
  const err = new Error('DB connection refused');
  let capturedError;
  const next = (e) => { capturedError = e; };

  const handler = asyncHandler(async () => {
    throw err;
  });

  await handler({}, {}, next);
  assert.equal(capturedError, err, 'next() should receive the thrown error');
});

test('asyncHandler forwards a rejected promise to next()', async () => {
  const err = new Error('Query failed');
  let capturedError;
  const next = (e) => { capturedError = e; };

  const handler = asyncHandler(() => Promise.reject(err));

  await handler({}, {}, next);
  assert.equal(capturedError, err, 'next() should receive the rejection reason');
});

test('asyncHandler does not call next() when handler resolves successfully', async () => {
  let nextCallCount = 0;
  const next = () => { nextCallCount++; };

  const handler = asyncHandler(async (_req, res) => {
    res.body = 'ok';
  });

  const res = {};
  await handler({}, res, next);
  assert.equal(res.body, 'ok');
  assert.equal(nextCallCount, 0, 'next() must not be called on success');
});
