const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
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
