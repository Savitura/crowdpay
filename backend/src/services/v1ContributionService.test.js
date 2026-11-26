const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function createV1Service({
  dbImpl = {},
  serverImpl = {},
  campaignStatusImpl = {},
  policyImpl = {},
  loggerImpl = {},
} = {}) {
  const queryLog = [];
  const clientQueryLog = [];
  let clientReleased = false;

  const defaultClient = {
    query: async (text, params) => {
      clientQueryLog.push({ text, params });
      if (dbImpl.clientQuery) {
        return dbImpl.clientQuery(text, params);
      }
      if (text.includes('INSERT INTO contributions')) {
        return {
          rows: [
            {
              id: 'contrib-new-1',
              campaign_id: params[0],
              sender_public_key: params[1],
              amount: params[2],
              asset: params[3],
              payment_type: params[4],
              source_amount: params[5],
              source_asset: params[6],
              conversion_rate: params[7],
              path: params[8],
              tx_hash: params[9],
            },
          ],
        };
      }
      if (text.includes('UPDATE campaigns')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {
      clientReleased = true;
      if (dbImpl.clientRelease) dbImpl.clientRelease();
    },
  };

  const dbStub = {
    query: async (text, params) => {
      queryLog.push({ text, params });
      if (dbImpl.query) return dbImpl.query(text, params);
      return { rows: [] };
    },
    connect: async () => {
      if (dbImpl.connect) return dbImpl.connect();
      return defaultClient;
    },
  };

  const serverStub = {
    transactions: () => ({
      transaction: txHash => ({
        call: async () => {
          if (serverImpl.transactionCall) return serverImpl.transactionCall(txHash);
          return { successful: true };
        },
      }),
    }),
    operations: () => ({
      forTransaction: txHash => ({
        call: async () => {
          if (serverImpl.operationsCall) return serverImpl.operationsCall(txHash);
          return { records: [] };
        },
      }),
    }),
  };

  const refreshedCampaigns = [];
  const campaignStatusStub = {
    refreshCampaignStatus: async id => {
      refreshedCampaigns.push(id);
      if (campaignStatusImpl.refreshCampaignStatus) {
        return campaignStatusImpl.refreshCampaignStatus(id);
      }
    },
  };

  const policyAssertions = [];
  const policyStub = {
    assertContributionPolicy: async (campaign, amount, senderPublicKey) => {
      policyAssertions.push({ campaign, amount, senderPublicKey });
      if (policyImpl.assertContributionPolicy) {
        return policyImpl.assertContributionPolicy(campaign, amount, senderPublicKey);
      }
    },
  };

  const loggerStub = {
    info: () => {},
    warn: () => {},
    error: () => {},
    ...loggerImpl,
  };

  const service = proxyquire('./v1ContributionService', {
    '../config/database': dbStub,
    '../config/stellar': { server: serverStub },
    '../config/logger': loggerStub,
    './campaignStatusService': campaignStatusStub,
    './contributionPolicy': policyStub,
  });

  return {
    service,
    queryLog,
    clientQueryLog,
    isClientReleased: () => clientReleased,
    refreshedCampaigns,
    policyAssertions,
  };
}

// ---------------------------------------------------------------------------
// parseContributionFromOperations
// ---------------------------------------------------------------------------

test('parseContributionFromOperations - throws 422 if operations array is empty', () => {
  const { service } = createV1Service();
  assert.throws(
    () => {
      service.parseContributionFromOperations([], { wallet_public_key: 'GCAMPAIGNWALLET' });
    },
    err => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /Transaction does not contain a payment to the campaign wallet/);
      return true;
    }
  );
});

test('parseContributionFromOperations - throws 422 if operations do not contain payment to campaign wallet', () => {
  const { service } = createV1Service();
  const ops = [
    { type: 'payment', to: 'GSOMEOTHERWALLET', amount: '50.0000000', from: 'GSENDER' },
    { type: 'create_account', to: 'GCAMPAIGNWALLET', starting_balance: '10.0000000' },
  ];
  assert.throws(
    () => {
      service.parseContributionFromOperations(ops, { wallet_public_key: 'GCAMPAIGNWALLET' });
    },
    err => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /Transaction does not contain a payment to the campaign wallet/);
      return true;
    }
  );
});

test('parseContributionFromOperations - parses direct native payment correctly', () => {
  const { service } = createV1Service();
  const ops = [
    {
      type: 'payment',
      to: 'GCAMPAIGNWALLET',
      from: 'GSENDERWALLET',
      amount: '125.5000000',
      asset_type: 'native',
    },
  ];

  const parsed = service.parseContributionFromOperations(ops, {
    wallet_public_key: 'GCAMPAIGNWALLET',
  });

  assert.deepEqual(parsed, {
    sender_public_key: 'GSENDERWALLET',
    amount: 125.5,
    asset: 'XLM',
    payment_type: 'payment',
    source_amount: null,
    source_asset: null,
    conversion_rate: null,
    path: null,
  });
});

test('parseContributionFromOperations - parses direct token payment correctly', () => {
  const { service } = createV1Service();
  const ops = [
    {
      type: 'payment',
      to: 'GCAMPAIGNWALLET',
      from: 'GSENDERWALLET',
      amount: '50.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
    },
  ];

  const parsed = service.parseContributionFromOperations(ops, {
    wallet_public_key: 'GCAMPAIGNWALLET',
  });

  assert.deepEqual(parsed, {
    sender_public_key: 'GSENDERWALLET',
    amount: 50,
    asset: 'USDC',
    payment_type: 'payment',
    source_amount: null,
    source_asset: null,
    conversion_rate: null,
    path: null,
  });
});

test('parseContributionFromOperations - parses path_payment_strict_receive correctly', () => {
  const { service } = createV1Service();
  const ops = [
    {
      type: 'path_payment_strict_receive',
      to: 'GCAMPAIGNWALLET',
      from: 'GSENDERWALLET',
      amount: '100.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      source_amount: '200.0000000',
      source_asset_type: 'native',
    },
  ];

  const parsed = service.parseContributionFromOperations(ops, {
    wallet_public_key: 'GCAMPAIGNWALLET',
  });

  assert.deepEqual(parsed, {
    sender_public_key: 'GSENDERWALLET',
    amount: 100,
    asset: 'USDC',
    payment_type: 'path_payment_strict_receive',
    source_amount: 200,
    source_asset: 'XLM',
    conversion_rate: 0.5, // destAmount / sourceAmount = 100 / 200 = 0.5
    path: null,
  });
});

// ---------------------------------------------------------------------------
// recordContributionFromTxHash
// ---------------------------------------------------------------------------

test('recordContributionFromTxHash - throws 404 if campaign is not found', async () => {
  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) return { rows: [] };
        return { rows: [] };
      },
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'nonexistent-campaign',
        txHash: '0xhash1',
      });
    },
    err => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /Campaign not found/);
      return true;
    }
  );
});

test('recordContributionFromTxHash - throws 409 if campaign status does not accept contributions', async () => {
  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) {
          return {
            rows: [
              {
                id: 'camp-draft',
                status: 'draft',
                wallet_public_key: 'GCAMP',
                asset_type: 'XLM',
              },
            ],
          };
        }
        return { rows: [] };
      },
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'camp-draft',
        txHash: '0xhash1',
      });
    },
    err => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Campaign status "draft" does not accept contributions/);
      return true;
    }
  );
});

test('recordContributionFromTxHash - throws 409 if contribution already recorded for txHash', async () => {
  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) {
          return {
            rows: [
              {
                id: 'camp-1',
                status: 'active',
                wallet_public_key: 'GCAMP',
                asset_type: 'XLM',
              },
            ],
          };
        }
        if (text.includes('FROM contributions WHERE tx_hash')) {
          return { rows: [{ id: 'contrib-existing' }] };
        }
        return { rows: [] };
      },
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'camp-1',
        txHash: '0xalready_recorded',
      });
    },
    err => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Contribution already recorded for this transaction/);
      return true;
    }
  );
});

test('recordContributionFromTxHash - throws 404 if Horizon transaction lookup fails', async () => {
  const warnings = [];
  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) {
          return {
            rows: [
              {
                id: 'camp-1',
                status: 'active',
                wallet_public_key: 'GCAMP',
                asset_type: 'XLM',
              },
            ],
          };
        }
        return { rows: [] };
      },
    },
    serverImpl: {
      transactionCall: async () => {
        throw new Error('Transaction not found on Horizon');
      },
    },
    loggerImpl: {
      warn: (msg, meta) => warnings.push({ msg, meta }),
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'camp-1',
        txHash: '0xhorizon_missing',
      });
    },
    err => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /Stellar transaction not found/);
      return true;
    }
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.tx_hash, '0xhorizon_missing');
});

test('recordContributionFromTxHash - throws 422 if Stellar transaction was not successful', async () => {
  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) {
          return {
            rows: [
              {
                id: 'camp-1',
                status: 'active',
                wallet_public_key: 'GCAMP',
                asset_type: 'XLM',
              },
            ],
          };
        }
        return { rows: [] };
      },
    },
    serverImpl: {
      transactionCall: async () => ({ successful: false }),
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'camp-1',
        txHash: '0xtx_failed',
      });
    },
    err => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /Stellar transaction was not successful/);
      return true;
    }
  );
});

test('recordContributionFromTxHash - throws 422 if payment asset does not match campaign base asset', async () => {
  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) {
          return {
            rows: [
              {
                id: 'camp-1',
                status: 'active',
                wallet_public_key: 'GCAMP',
                asset_type: 'USDC', // Expects USDC
              },
            ],
          };
        }
        return { rows: [] };
      },
    },
    serverImpl: {
      transactionCall: async () => ({ successful: true }),
      operationsCall: async () => ({
        records: [
          {
            type: 'payment',
            to: 'GCAMP',
            from: 'GSENDER',
            amount: '50.0000000',
            asset_type: 'native', // Sends XLM instead of USDC
          },
        ],
      }),
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'camp-1',
        txHash: '0xasset_mismatch',
      });
    },
    err => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /Transaction must pay in the campaign's base asset \(USDC\)/);
      return true;
    }
  );
});

test('recordContributionFromTxHash - records valid contribution and updates campaign raised amount', async () => {
  const campaignRecord = {
    id: 'camp-1',
    wallet_public_key: 'GCAMP_KEY',
    asset_type: 'XLM',
    status: 'active',
    raised_amount: '400',
    target_amount: '500',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    min_contribution: '10',
    max_contribution: '200',
    max_per_user: '500',
  };

  const { service, clientQueryLog, isClientReleased, refreshedCampaigns, policyAssertions } =
    createV1Service({
      dbImpl: {
        query: async text => {
          if (text.includes('FROM campaigns WHERE id = $1')) {
            return { rows: [campaignRecord] };
          }
          if (text.includes('FROM contributions WHERE tx_hash = $1')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      },
      serverImpl: {
        transactionCall: async () => ({ successful: true }),
        operationsCall: async () => ({
          records: [
            {
              type: 'payment',
              to: 'GCAMP_KEY',
              from: 'GSENDER_PUBLIC_KEY',
              amount: '100.0000000',
              asset_type: 'native',
            },
          ],
        }),
      },
    });

  const result = await service.recordContributionFromTxHash({
    campaignId: 'camp-1',
    txHash: '0xsuccess_contribution_hash',
  });

  // Policy assertion verified
  assert.equal(policyAssertions.length, 1);
  assert.equal(policyAssertions[0].amount, 100);
  assert.equal(policyAssertions[0].senderPublicKey, 'GSENDER_PUBLIC_KEY');

  // DB client queries executed in transaction
  const queries = clientQueryLog.map(q => q.text);
  assert.equal(queries[0], 'BEGIN');
  assert.ok(queries[1].includes('INSERT INTO contributions'));
  assert.ok(queries[2].includes('UPDATE campaigns'));
  assert.equal(queries[3], 'COMMIT');

  // Campaign status refreshed
  assert.deepEqual(refreshedCampaigns, ['camp-1']);

  // Client released
  assert.equal(isClientReleased(), true);

  // Return value matches inserted contribution
  assert.equal(result.id, 'contrib-new-1');
  assert.equal(result.amount, 100);
  assert.equal(result.asset, 'XLM');
  assert.equal(result.tx_hash, '0xsuccess_contribution_hash');
});

test('recordContributionFromTxHash - executes ROLLBACK and releases client if DB insert fails', async () => {
  const campaignRecord = {
    id: 'camp-1',
    wallet_public_key: 'GCAMP_KEY',
    asset_type: 'XLM',
    status: 'active',
  };

  const clientQueryLog = [];
  let released = false;

  const { service } = createV1Service({
    dbImpl: {
      query: async text => {
        if (text.includes('FROM campaigns')) return { rows: [campaignRecord] };
        return { rows: [] };
      },
      connect: async () => ({
        query: async (text, params) => {
          clientQueryLog.push({ text, params });
          if (text === 'BEGIN') return {};
          if (text.includes('INSERT INTO contributions')) {
            throw new Error('Database disk error');
          }
          if (text === 'ROLLBACK') return {};
          return {};
        },
        release: () => {
          released = true;
        },
      }),
    },
    serverImpl: {
      transactionCall: async () => ({ successful: true }),
      operationsCall: async () => ({
        records: [
          {
            type: 'payment',
            to: 'GCAMP_KEY',
            from: 'GSENDER',
            amount: '50.0000000',
            asset_type: 'native',
          },
        ],
      }),
    },
  });

  await assert.rejects(
    async () => {
      await service.recordContributionFromTxHash({
        campaignId: 'camp-1',
        txHash: '0xdb_failure_hash',
      });
    },
    err => {
      assert.match(err.message, /Database disk error/);
      return true;
    }
  );

  const queryTexts = clientQueryLog.map(q => q.text);
  assert.equal(queryTexts[0], 'BEGIN');
  assert.ok(queryTexts[1].includes('INSERT INTO contributions'));
  assert.equal(queryTexts[2], 'ROLLBACK');
  assert.equal(released, true);
});
