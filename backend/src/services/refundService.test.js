const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params && [...params] });
      return queryImpl(sql, params);
    },
    release() {},
  };
  const db = {
    connect: async () => client,
    query: async (sql, params) => client.query(sql, params),
  };
  return {
    service: proxyquire('./refundService', {
      '../config/database': db,
      '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
      './stellarService': {},
    }),
    calls,
  };
}

test('getEligibleContributions handles pagination bounds correctly', async () => {
  const { service, calls } = buildService(async () => ({ rows: [{ id: 'c-1' }] }));
  const results = await service.getEligibleContributions('camp-1', { limit: 10, offset: 0 });
  assert.equal(results.length, 1);
  assert.deepEqual(calls[0].params, ['camp-1', 10, 0]);
});

test('getCampaignRefunds applies status filtering and clamps pagination', async () => {
  const { service, calls } = buildService(async sql => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '3' }] };
    return { rows: [{ id: 'refund-1' }] };
  });

  const result = await service.getCampaignRefunds('camp-1', {
    status: 'completed',
    limit: 900,
    offset: -4,
  });

  assert.deepEqual(result, {
    total: 3,
    limit: 500,
    offset: 0,
    items: [{ id: 'refund-1' }],
  });
  assert.deepEqual(calls[0].params, ['camp-1', 'completed']);
  assert.deepEqual(calls[1].params, ['camp-1', 'completed', 500, 0]);
});

test('listRefunds applies bounded pagination to the campaign query', async () => {
  const { service, calls } = buildService(async () => ({ rows: [{ id: 'refund-1' }] }));

  const result = await service.listRefunds('camp-1', { limit: 0, offset: -2 });

  assert.deepEqual(result, [{ id: 'refund-1' }]);
  assert.deepEqual(calls[0].params, ['camp-1', 50, 0]);
});

const contribRow = {
  id: 'contrib-1',
  campaign_id: 'camp-1',
  sender_public_key: 'GABC',
  amount: '100',
  refunded_amount: '0',
  wallet_public_key: 'GCAMPAIGN',
  creator_id: 'creator-1',
};

test('processRefund succeeds with a valid transaction hash', async () => {
  const { service } = buildService(async sql => {
    if (sql.includes('FOR UPDATE')) return { rows: [contribRow] };
    if (sql.includes('INSERT INTO creator_refunds')) {
      return { rows: [{ id: 'ref-1', status: 'completed', tx_hash: 'txhash123' }] };
    }
    return { rows: [] };
  });

  const stellarService = { sendCampaignRefund: async () => ({ txHash: 'txhash123' }) };

  const res = await service.processRefund('contrib-1', '50', stellarService);
  assert.equal(res.status, 'completed');
  assert.equal(res.tx_hash, 'txhash123');
});

test('processRefund rejects amounts above the remaining contribution balance before chain submission', async () => {
  const { service } = buildService(async sql => {
    if (sql.includes('FOR UPDATE')) {
      return {
        rows: [{ ...contribRow, amount: '100', refunded_amount: '75' }],
      };
    }
    return { rows: [] };
  });
  let called = false;

  await assert.rejects(
    () =>
      service.processRefund('contrib-1', 26, {
        sendCampaignRefund: async () => {
          called = true;
          return { txHash: 'unexpected' };
        },
      }),
    err => err.status === 422 && /exceeds remaining/.test(err.message)
  );
  assert.equal(called, false);
});

test('processRefund uses the dispute-refund fallback and accepts its hash result', async () => {
  const { service, calls } = buildService(async sql => {
    if (sql.includes('FOR UPDATE')) return { rows: [contribRow] };
    if (sql.includes('INSERT INTO creator_refunds')) {
      return { rows: [{ id: 'ref-2', tx_hash: 'fallback-hash' }] };
    }
    return { rows: [] };
  });
  const submitCalls = [];
  const fallbackService = {
    submitDisputeRefund: async payload => {
      submitCalls.push(payload);
      return { hash: 'fallback-hash' };
    },
  };

  const result = await service.processRefund('contrib-1', '25', fallbackService);

  assert.equal(result.tx_hash, 'fallback-hash');
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0].campaignWalletPublicKey, 'GCAMPAIGN');
  assert.equal(submitCalls[0].refunds[0].walletPublicKey, 'GABC');
  assert.deepEqual(calls.find(call => call.sql.includes('UPDATE contributions')).params, [
    25,
    'contrib-1',
  ]);
  assert.deepEqual(calls.find(call => call.sql.includes('UPDATE campaigns')).params, [
    25,
    'camp-1',
  ]);
});

test('processRefund rejects a missing contribution before contacting the chain', async () => {
  const { service } = buildService(async () => ({ rows: [] }));
  let called = false;

  await assert.rejects(
    () =>
      service.processRefund('missing', 10, {
        sendCampaignRefund: async () => {
          called = true;
          return { txHash: 'unexpected' };
        },
      }),
    err => err.status === 404 && /not found/.test(err.message)
  );
  assert.equal(called, false);
});

test('processRefund throws a 502 when the signer is missing a sender function', async () => {
  const { service } = buildService(async sql => {
    if (sql.includes('FOR UPDATE')) return { rows: [contribRow] };
    return { rows: [] };
  });

  await assert.rejects(
    () => service.processRefund('contrib-1', '50', {}),
    err => {
      assert.match(err.message, /missing transaction hash/i);
      assert.equal(err.status, 502);
      return true;
    }
  );
});

test('processRefund throws a 502 when the on-chain sender rejects', async () => {
  const { service } = buildService(async sql => {
    if (sql.includes('FOR UPDATE')) return { rows: [contribRow] };
    return { rows: [] };
  });

  const stellarService = {
    sendCampaignRefund: async () => {
      throw new Error('Network error');
    },
  };

  await assert.rejects(
    () => service.processRefund('contrib-1', '50', stellarService),
    err => {
      assert.equal(err.status, 502);
      return true;
    }
  );
});
