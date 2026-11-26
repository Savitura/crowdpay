const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadAdapter({ initImpl, client } = {}) {
  const initCalls = [];
  const LaunchDarklyAdapter = proxyquire('./launchDarklyAdapter', {
    'launchdarkly-node-server-sdk': {
      init(sdkKey) {
        initCalls.push(sdkKey);
        if (initImpl) return initImpl(sdkKey);
        return client;
      },
    },
  });
  return { LaunchDarklyAdapter, initCalls };
}

test('LaunchDarklyAdapter stays disabled when no SDK key is configured', async () => {
  const { LaunchDarklyAdapter, initCalls } = loadAdapter();
  const adapter = new LaunchDarklyAdapter({});

  assert.equal(initCalls.length, 0);
  assert.equal(await adapter.isEnabled('new-dashboard', { userId: 'user-1' }), false);
  assert.deepEqual(await adapter.getVariant('new-dashboard'), { name: 'disabled', enabled: false });
});

test('LaunchDarklyAdapter falls back when the SDK fails to initialise', async () => {
  const { LaunchDarklyAdapter } = loadAdapter({
    initImpl() {
      throw new Error('sdk timeout');
    },
  });
  const adapter = new LaunchDarklyAdapter({ sdkKey: 'sdk-key' });

  assert.equal(await adapter.isEnabled('new-dashboard'), false);
  assert.deepEqual(await adapter.getVariant('new-dashboard'), { name: 'disabled', enabled: false });
});

test('LaunchDarklyAdapter evaluates flags for a known user', async () => {
  const variationCalls = [];
  const { LaunchDarklyAdapter } = loadAdapter({
    client: {
      async variation(flagKey, context, fallback) {
        variationCalls.push({ flagKey, context, fallback });
        return true;
      },
      async variationDetail(flagKey, context, fallback) {
        variationCalls.push({ flagKey, context, fallback, detail: true });
        return { variationIndex: 2, value: { color: 'blue' } };
      },
    },
  });
  const adapter = new LaunchDarklyAdapter({ sdkKey: 'sdk-key' });

  assert.equal(
    await adapter.isEnabled('new-dashboard', { userId: 'user-1', custom: { plan: 'pro' } }),
    true
  );
  const variant = await adapter.getVariant('new-dashboard', {
    userId: 'user-1',
    custom: { plan: 'pro' },
  });

  assert.equal(variationCalls[0].context.key, 'user-1');
  assert.equal(variationCalls[0].context.anonymous, false);
  assert.deepEqual(variationCalls[0].context.custom, { plan: 'pro' });
  assert.equal(variationCalls[0].fallback, false);
  assert.deepEqual(variant, { name: '2', enabled: true, payload: { color: 'blue' } });
});

test('LaunchDarklyAdapter uses an anonymous context and falls back when the SDK times out', async () => {
  const { LaunchDarklyAdapter } = loadAdapter({
    client: {
      async variation(_flagKey, context) {
        assert.equal(context.key, 'anonymous');
        assert.equal(context.anonymous, true);
        throw new Error('429 rate limit');
      },
      async variationDetail() {
        throw new Error('timeout');
      },
    },
  });
  const adapter = new LaunchDarklyAdapter({ sdkKey: 'sdk-key' });

  assert.equal(await adapter.isEnabled('new-dashboard'), false);
  assert.deepEqual(await adapter.getVariant('new-dashboard'), { name: 'disabled', enabled: false });
});
