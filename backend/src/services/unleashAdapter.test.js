const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadAdapter({ initImpl, client } = {}) {
  const initCalls = [];
  const UnleashAdapter = proxyquire('./unleashAdapter', {
    'unleash-client': {
      initialize(config) {
        initCalls.push(config);
        if (initImpl) return initImpl(config);
        return client;
      },
    },
  });
  return { UnleashAdapter, initCalls };
}

test('UnleashAdapter stays disabled when configuration is incomplete', () => {
  const { UnleashAdapter, initCalls } = loadAdapter();
  const adapter = new UnleashAdapter({ url: 'https://unleash.test' });

  assert.equal(initCalls.length, 0);
  assert.equal(adapter.isEnabled('new-dashboard', { userId: 'user-1' }), false);
  assert.deepEqual(adapter.getVariant('new-dashboard'), { name: 'disabled', enabled: false });
});

test('UnleashAdapter falls back when the client fails to initialise', () => {
  const { UnleashAdapter } = loadAdapter({
    initImpl() {
      throw new Error('connection timeout');
    },
  });
  const adapter = new UnleashAdapter({
    url: 'https://unleash.test',
    apiToken: 'token',
    appName: 'crowdpay',
  });

  assert.equal(adapter.isEnabled('new-dashboard'), false);
  assert.deepEqual(adapter.getVariant('new-dashboard'), { name: 'disabled', enabled: false });
});

test('UnleashAdapter evaluates flags and variants with the caller context', () => {
  const calls = [];
  const { UnleashAdapter, initCalls } = loadAdapter({
    client: {
      isEnabled(flagKey, context, fallback) {
        calls.push({ kind: 'enabled', flagKey, context, fallback });
        return true;
      },
      getVariant(flagKey, context) {
        calls.push({ kind: 'variant', flagKey, context });
        return { name: 'treatment', enabled: true, payload: { group: 'b' } };
      },
    },
  });
  const adapter = new UnleashAdapter({
    url: 'https://unleash.test',
    apiToken: 'token',
    appName: 'crowdpay',
    environment: 'production',
  });

  assert.equal(
    adapter.isEnabled('new-dashboard', {
      userId: 'user-1',
      sessionId: 'sess',
      ip: '127.0.0.1',
      custom: { plan: 'pro' },
    }),
    true
  );
  assert.deepEqual(
    adapter.getVariant('new-dashboard', { userId: 'user-1', custom: { plan: 'pro' } }),
    {
      name: 'treatment',
      enabled: true,
      payload: { group: 'b' },
    }
  );
  assert.equal(initCalls[0].environment, 'production');
  assert.equal(initCalls[0].customHeaders.Authorization, 'token');
  assert.equal(calls[0].context.remoteAddress, '127.0.0.1');
  assert.equal(calls[0].fallback, false);
  assert.deepEqual(calls[1].context.properties, { plan: 'pro' });
});

test('UnleashAdapter falls back when the SDK reports a rate limit or timeout', () => {
  const { UnleashAdapter } = loadAdapter({
    client: {
      isEnabled() {
        throw new Error('429 rate limit');
      },
      getVariant() {
        throw new Error('timeout');
      },
    },
  });
  const adapter = new UnleashAdapter({
    url: 'https://unleash.test',
    apiToken: 'token',
    appName: 'crowdpay',
  });

  assert.equal(adapter.isEnabled('new-dashboard', { userId: 'user-1' }), false);
  assert.deepEqual(adapter.getVariant('new-dashboard'), { name: 'disabled', enabled: false });
});

test('UnleashAdapter uses a disabled variant name when the SDK omits one', () => {
  const { UnleashAdapter } = loadAdapter({
    client: {
      isEnabled() {
        return false;
      },
      getVariant() {
        return { enabled: false };
      },
    },
  });
  const adapter = new UnleashAdapter({
    url: 'https://unleash.test',
    apiToken: 'token',
    appName: 'crowdpay',
  });

  assert.equal(adapter.isEnabled('new-dashboard'), false);
  assert.deepEqual(adapter.getVariant('new-dashboard'), {
    name: 'disabled',
    enabled: false,
    payload: undefined,
  });
});
