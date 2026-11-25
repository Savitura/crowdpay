const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');

// The middleware only owns request validation; token storage is covered by
// embedTokenService. Stub both the service and asyncHandler so these tests
// exercise the middleware's own branches synchronously.
function loadMiddleware(validateEmbedToken) {
  return proxyquire('./embedAuth', {
    '../services/embedTokenService': { validateEmbedToken },
    '../utils/asyncHandler': handler => handler,
  });
}

function mockRes() {
  return {
    statusCode: 0,
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

const ACTIVE_TOKEN = { id: 'token-1', campaignId: 'campaign-1', user_id: 'user-1' };

test('requireEmbedToken rejects requests without an embedToken query param', async () => {
  let called = false;
  const { requireEmbedToken } = loadMiddleware(async () => {
    called = true;
    return ACTIVE_TOKEN;
  });
  const req = { query: {}, params: {} };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(called, false, 'token lookup must not run without a token');
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'embedToken is required' });
});

test('requireEmbedToken rejects invalid or revoked tokens', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => null);
  const req = { query: { embedToken: 'cped_revoked' }, params: {} };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid or revoked embed token' });
  assert.equal(req.embedToken, undefined);
});

test('requireEmbedToken rejects a token issued for another campaign', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => ACTIVE_TOKEN);
  const req = {
    query: { embedToken: 'cped_valid' },
    params: { campaignId: 'campaign-2' },
  };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Embed token does not match campaign' });
});

test('requireEmbedToken attaches the token when it matches campaignId in params', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => ACTIVE_TOKEN);
  const req = {
    query: { embedToken: 'cped_valid' },
    params: { campaignId: 'campaign-1' },
  };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 0, 'no response should be written on success');
  assert.deepEqual(req.embedToken, ACTIVE_TOKEN);
});

test('requireEmbedToken attaches the token when it matches campaignId in the query', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => ACTIVE_TOKEN);
  const req = {
    query: { embedToken: 'cped_valid', campaignId: 'campaign-1' },
    params: {},
  };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.embedToken, ACTIVE_TOKEN);
});

test('requireEmbedToken attaches the token when no campaignId is requested', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => ACTIVE_TOKEN);
  const req = { query: { embedToken: 'cped_valid' }, params: {} };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.embedToken, ACTIVE_TOKEN);
});

test('requireEmbedToken compares numeric and string campaign ids consistently', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => ({ ...ACTIVE_TOKEN, campaignId: 42 }));
  const req = { query: { embedToken: 'cped_valid' }, params: { campaignId: '42' } };
  const res = mockRes();
  let nextCalled = false;

  await requireEmbedToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 0);
});

test('requireEmbedToken passes lookup failures to the caller instead of answering', async () => {
  const { requireEmbedToken } = loadMiddleware(async () => {
    throw new Error('database unavailable');
  });
  const req = { query: { embedToken: 'cped_valid' }, params: {} };
  const res = mockRes();

  await assert.rejects(
    () => requireEmbedToken(req, res, () => assert.fail('next() must not run on failure')),
    /database unavailable/
  );
  assert.equal(res.statusCode, 0);
});
