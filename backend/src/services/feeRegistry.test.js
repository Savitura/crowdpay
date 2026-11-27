const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function createMockCache() {
  const store = new Map();
  return {
    get: key => store.get(key),
    set: (key, val) => store.set(key, val),
    invalidate: key => store.delete(key),
    _store: store,
  };
}

function buildFeeRegistry({ contractId = 'CCONTRACTFEE123', invokeContractReadOnlyImpl } = {}) {
  const originalContractId = process.env.FEE_REGISTRY_CONTRACT_ID;
  if (contractId !== undefined) {
    process.env.FEE_REGISTRY_CONTRACT_ID = contractId;
  } else {
    delete process.env.FEE_REGISTRY_CONTRACT_ID;
  }

  const mockCache = createMockCache();
  const logs = { info: [], warn: [], error: [] };

  const service = proxyquire('./feeRegistry', {
    './sorobanService': {
      invokeContractReadOnly: invokeContractReadOnlyImpl || (async () => 250),
      nativeToScVal: val => val,
    },
    '../utils/cache': mockCache,
    '../config/logger': {
      info: (msg, meta) => logs.info.push({ msg, meta }),
      warn: (msg, meta) => logs.warn.push({ msg, meta }),
      error: (msg, meta) => logs.error.push({ msg, meta }),
      debug: () => {},
    },
  });

  return {
    service,
    mockCache,
    logs,
    restore: () => {
      if (originalContractId !== undefined) {
        process.env.FEE_REGISTRY_CONTRACT_ID = originalContractId;
      } else {
        delete process.env.FEE_REGISTRY_CONTRACT_ID;
      }
    },
  };
}

test('fetchPlatformFeeFromContract returns default when FEE_REGISTRY_CONTRACT_ID is unset', async () => {
  const originalEnv = process.env.FEE_REGISTRY_CONTRACT_ID;
  delete process.env.FEE_REGISTRY_CONTRACT_ID;

  const mockCache = createMockCache();
  const service = proxyquire('./feeRegistry', {
    './sorobanService': { invokeContractReadOnly: async () => 300 },
    '../utils/cache': mockCache,
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
  });

  const fee = await service.fetchPlatformFeeFromContract();
  assert.equal(fee, 250);

  if (originalEnv) process.env.FEE_REGISTRY_CONTRACT_ID = originalEnv;
});

test('fetchPlatformFeeFromContract invokes contract and parses response', async () => {
  let invokedWith = null;
  const { service, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async opts => {
      invokedWith = opts;
      return 350;
    },
  });

  const fee = await service.fetchPlatformFeeFromContract();
  assert.equal(fee, 350);
  assert.equal(invokedWith.contractId, 'CFEE123');
  assert.equal(invokedWith.method, 'get_fee');
  restore();
});

test('fetchPlatformFeeFromContract catches errors and falls back to default fee', async () => {
  const { service, logs, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async () => {
      throw new Error('RPC failure');
    },
  });

  const fee = await service.fetchPlatformFeeFromContract();
  assert.equal(fee, 250);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0].meta.error, /RPC failure/);
  restore();
});

test('fetchCreatorShareFromContract returns default when contract ID is unset', async () => {
  const originalEnv = process.env.FEE_REGISTRY_CONTRACT_ID;
  delete process.env.FEE_REGISTRY_CONTRACT_ID;

  const mockCache = createMockCache();
  const service = proxyquire('./feeRegistry', {
    './sorobanService': { invokeContractReadOnly: async () => 600 },
    '../utils/cache': mockCache,
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
  });

  const share = await service.fetchCreatorShareFromContract();
  assert.equal(share, 500);

  if (originalEnv) process.env.FEE_REGISTRY_CONTRACT_ID = originalEnv;
});

test('fetchCreatorShareFromContract invokes contract and parses response', async () => {
  let invokedWith = null;
  const { service, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async opts => {
      invokedWith = opts;
      return 600;
    },
  });

  const share = await service.fetchCreatorShareFromContract();
  assert.equal(share, 600);
  assert.equal(invokedWith.contractId, 'CFEE123');
  assert.equal(invokedWith.method, 'get_creator_share');
  restore();
});

test('fetchCreatorShareFromContract catches errors and falls back to default', async () => {
  const { service, logs, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async () => {
      throw new Error('Simulation timeout');
    },
  });

  const share = await service.fetchCreatorShareFromContract();
  assert.equal(share, 500);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0].meta.error, /Simulation timeout/);
  restore();
});

test('getPlatformFee uses cached value when available', async () => {
  const { service, mockCache, restore } = buildFeeRegistry();
  mockCache.set('platform_fee_bps', 275);

  const fee = await service.getPlatformFee();
  assert.equal(fee, 275);
  restore();
});

test('getPlatformFee populates cache on miss', async () => {
  const { service, mockCache, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async () => 320,
  });

  const fee = await service.getPlatformFee();
  assert.equal(fee, 320);
  assert.equal(mockCache.get('platform_fee_bps'), 320);
  restore();
});

test('getCreatorShare uses cached value and populates on miss', async () => {
  const { service, mockCache, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async () => 450,
  });

  const share = await service.getCreatorShare();
  assert.equal(share, 450);
  assert.equal(mockCache.get('creator_share_bps'), 450);

  // Subsequent call should hit cache
  mockCache.set('creator_share_bps', 550);
  const cachedShare = await service.getCreatorShare();
  assert.equal(cachedShare, 550);
  restore();
});

test('calculatePlatformFee and calculateCreatorShare compute correct basis point amounts', async () => {
  const { service, mockCache, restore } = buildFeeRegistry();
  mockCache.set('platform_fee_bps', 250); // 2.5%
  mockCache.set('creator_share_bps', 1000); // 10%

  const fee = await service.calculatePlatformFee(1000);
  assert.equal(fee, 25);

  const creatorShare = await service.calculateCreatorShare(100);
  assert.equal(creatorShare, 10);
  restore();
});

test('invalidateFeeCache clears cache entries', () => {
  const { service, mockCache, restore } = buildFeeRegistry();
  mockCache.set('platform_fee_bps', 250);
  mockCache.set('creator_share_bps', 500);

  service.invalidateFeeCache();
  assert.equal(mockCache.get('platform_fee_bps'), undefined);
  assert.equal(mockCache.get('creator_share_bps'), undefined);
  restore();
});

test('refreshFeeCache updates cache with fresh values from contract', async () => {
  const { service, mockCache, restore } = buildFeeRegistry({
    contractId: 'CFEE123',
    invokeContractReadOnlyImpl: async ({ method }) => {
      if (method === 'get_fee') return 275;
      if (method === 'get_creator_share') return 525;
      return 0;
    },
  });

  await service.refreshFeeCache();
  assert.equal(mockCache.get('platform_fee_bps'), 275);
  assert.equal(mockCache.get('creator_share_bps'), 525);
  restore();
});

test('getFeeRegistryInfo returns structured fee metadata', async () => {
  const { service, mockCache, restore } = buildFeeRegistry({ contractId: 'CREGISTRY_ADDR' });
  mockCache.set('platform_fee_bps', 250);
  mockCache.set('creator_share_bps', 500);

  const info = await service.getFeeRegistryInfo();
  assert.deepEqual(info, {
    platform_fee_bps: 250,
    platform_fee_percent: '2.50',
    creator_share_bps: 500,
    creator_share_percent: '5.00',
    contract_id: 'CREGISTRY_ADDR',
  });
  restore();
});
