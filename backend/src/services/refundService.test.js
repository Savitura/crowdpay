const { describe, it, expect, vi, beforeEach } = require('vitest');

const assert = require('node:assert/strict');

const proxyquire = require('proxyquire').noCallThru();

function makeMockDb(queryHandler) {
  const client = {
    queryLog: [],
    async query(sql, params) {
      this.queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (queryHandler) return queryHandler(sql, params, this);
      return { rows: [] };
    },
    release() {},
  };
  return {
    connect: async () => client,
    query: async (sql, params) => client.query(sql, params),
    _client: client,
  };
}
const refundService = require('./refundService');
const db = require('../config/database');

vi.mock('../config/database', () => {
  const mClient = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    pool: {
      connect: vi.fn().mockResolvedValue(mClient),
    },
    query: vi.fn(),
  };
});

describe('refundService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getEligibleContributions handles pagination bounds correctly', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] });
    const results = await refundService.getEligibleContributions('camp-1', { limit: 10, offset: 0 });
    expect(results).toHaveLength(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.any(String),
      ['camp-1', 10, 0]
    );
  });

  it('processRefund succeeds with valid transaction hash', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'contrib-1', campaign_id: 'camp-1', sender_public_key: 'GABC', amount: '100', refunded_amount: '0' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'ref-1', status: 'completed', tx_hash: 'txhash123' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };
    db.pool.connect.mockResolvedValueOnce(mockClient);

    const mockStellarService = {
      sendCampaignRefund: vi.fn().mockResolvedValue({ txHash: 'txhash123' }),
    };

    const res = await refundService.processRefund('contrib-1', '50', mockStellarService);
    expect(res.status).toBe('completed');
    expect(res.tx_hash).toBe('txhash123');
    expect(mockStellarService.sendCampaignRefund).toHaveBeenCalled();
  });

  it('processRefund throws when sender function is missing', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'contrib-1', campaign_id: 'camp-1', sender_public_key: 'GABC', amount: '100', refunded_amount: '0' }] })
        .mockResolvedValueOnce({}), // ROLLBACK
      release: vi.fn(),
    };
    db.pool.connect.mockResolvedValueOnce(mockClient);

    const mockStellarService = {};

    await expect(refundService.processRefund('contrib-1', '50', mockStellarService)).rejects.toThrow(
      /missing transaction hash/i
    );
  });

  it('processRefund throws when sender throws an error', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'contrib-1', campaign_id: 'camp-1', sender_public_key: 'GABC', amount: '100', refunded_amount: '0' }] })
        .mockResolvedValueOnce({}), // ROLLBACK
      release: vi.fn(),
    };
    db.pool.connect.mockResolvedValueOnce(mockClient);

    const mockStellarService = {
      sendCampaignRefund: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    await expect(refundService.processRefund('contrib-1', '50', mockStellarService)).rejects.toThrow(
      'Network error'
    );
  });
});
