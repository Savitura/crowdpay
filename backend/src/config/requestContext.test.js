const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const requestContextMiddleware = require('./requestContext');
const { getRequestContext, runWithContext } = requestContextMiddleware;

function runMiddleware(req) {
  return new Promise((resolve, reject) => {
    requestContextMiddleware(req, {}, () => {
      tick()
        .then(() => resolve(getRequestContext()))
        .catch(reject);
    });
  });
}

test('requestContext: returns an empty object outside a request scope', () => {
  assert.deepEqual(getRequestContext(), {});
});

test('requestContext: the fallback outside a scope is a fresh object each call', () => {
  const first = getRequestContext();
  first.requestId = 'leaked';

  assert.deepEqual(getRequestContext(), {});
  assert.notEqual(getRequestContext(), first);
});

test('requestContext: runWithContext exposes the context and returns the callback result', () => {
  const context = { requestId: 'req-1' };

  const result = runWithContext(context, () => {
    assert.equal(getRequestContext(), context);
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(getRequestContext(), {});
});

test('requestContext: the context survives awaits and timers inside the scope', async () => {
  await runWithContext({ requestId: 'req-async' }, async () => {
    await tick();
    assert.equal(getRequestContext().requestId, 'req-async');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(getRequestContext().requestId, 'req-async');
  });

  assert.deepEqual(getRequestContext(), {});
});

test('requestContext: concurrent scopes stay isolated while their work interleaves', async () => {
  const seen = [];
  const work = (requestId, delays) =>
    runWithContext({ requestId }, async () => {
      for (const delay of delays) {
        await new Promise(resolve => setTimeout(resolve, delay));
        seen.push([requestId, getRequestContext().requestId]);
      }
    });

  await Promise.all([
    work('req-a', [10, 1, 5]),
    work('req-b', [1, 10, 1]),
    work('req-c', [5, 5, 5]),
  ]);

  assert.equal(seen.length, 9);
  for (const [expected, actual] of seen) {
    assert.equal(actual, expected);
  }
  assert.notDeepEqual(
    seen.map(([id]) => id),
    ['req-a', 'req-a', 'req-a', 'req-b', 'req-b', 'req-b', 'req-c', 'req-c', 'req-c']
  );
});

test('requestContext: writes to one scope are not visible to another', async () => {
  const first = runWithContext({ requestId: 'req-1' }, async () => {
    getRequestContext().userId = 'user-1';
    await tick();
    return getRequestContext();
  });
  const second = runWithContext({ requestId: 'req-2' }, async () => {
    await tick();
    return getRequestContext();
  });

  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(a, { requestId: 'req-1', userId: 'user-1' });
  assert.deepEqual(b, { requestId: 'req-2' });
});

test('requestContext: a nested scope shadows the outer one and restores it afterwards', () => {
  runWithContext({ requestId: 'outer' }, () => {
    runWithContext({ requestId: 'inner' }, () => {
      assert.equal(getRequestContext().requestId, 'inner');
    });
    assert.equal(getRequestContext().requestId, 'outer');
  });
});

test('requestContext: an error thrown inside the scope propagates and leaves no context behind', () => {
  assert.throws(
    () =>
      runWithContext({ requestId: 'req-error' }, () => {
        throw new Error('boom');
      }),
    /boom/
  );

  assert.deepEqual(getRequestContext(), {});
});

test('requestContext: middleware takes the requestId from req.id first', async () => {
  const context = await runMiddleware({
    id: 'from-req-id',
    headers: { 'x-request-id': 'from-header' },
  });

  assert.deepEqual(context, { requestId: 'from-req-id' });
});

test('requestContext: middleware falls back to the x-request-id header', async () => {
  const context = await runMiddleware({ headers: { 'x-request-id': 'from-header' } });

  assert.deepEqual(context, { requestId: 'from-header' });
});

test('requestContext: middleware sets an undefined requestId when none is provided', async () => {
  const context = await runMiddleware({ headers: {} });

  assert.deepEqual(context, { requestId: undefined });
  assert.ok(Object.hasOwn(context, 'requestId'));
});

test('requestContext: concurrent requests through the middleware keep their own ids', async () => {
  const ids = Array.from({ length: 20 }, (_, index) => `req-${index}`);

  const contexts = await Promise.all(
    ids.map(id => runMiddleware({ headers: { 'x-request-id': id } }))
  );

  assert.deepEqual(
    contexts.map(context => context.requestId),
    ids
  );
  assert.deepEqual(getRequestContext(), {});
});
