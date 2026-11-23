const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function createDiagnosticsService({ transactionCall } = {}) {
  const warnings = [];
  const serverStub = {
    transactions: () => ({
      transaction: () => ({
        call: transactionCall || (async () => ({ successful: true, operations: [] })),
      }),
    }),
  };

  const loggerStub = {
    info: () => {},
    warn: (msg, meta) => warnings.push({ msg, meta }),
    error: () => {},
  };

  const service = proxyquire('./contributionDiagnostics', {
    '../config/stellar': { server: serverStub },
    '../config/logger': loggerStub,
  });

  return { service, warnings };
}

test('contributionDiagnostics - exported constants', () => {
  const { service } = createDiagnosticsService();
  assert.equal(service.STATUS_PENDING, 'pending');
  assert.equal(service.STATUS_COMPLETED, 'completed');
  assert.equal(service.STATUS_FAILED, 'failed');
});

test('contributionDiagnostics - returns default report when tx_hash is not provided', async () => {
  let serverCalled = false;
  const { service } = createDiagnosticsService({
    transactionCall: async () => {
      serverCalled = true;
      return {};
    },
  });

  const report = await service.diagnoseContribution({
    contribution: {
      id: 'contrib-123',
      campaign_id: 'camp-456',
      payment_type: 'path_payment_strict_receive',
      diagnosis: 'pending',
      retry_count: 2,
    },
    metadata: {
      slippage_bps: 200,
      send_max: '55.00',
    },
  });

  assert.equal(serverCalled, false);
  assert.equal(report.contribution_id, 'contrib-123');
  assert.equal(report.campaign_id, 'camp-456');
  assert.equal(report.tx_hash, null);
  assert.equal(report.flow, 'path_payment_strict_receive');
  assert.equal(report.status, 'pending');
  assert.equal(report.allowed_slippage_bps, 200);
  assert.equal(report.send_max, '55.00');
  assert.equal(report.retry_count, 2);
  assert.equal(report.path_hops, null);
});

test('contributionDiagnostics - handles 404 from Horizon when tx is not yet on ledger', async () => {
  const notFoundError = new Error('Not found');
  notFoundError.response = { status: 404 };

  const { service } = createDiagnosticsService({
    transactionCall: async () => {
      throw notFoundError;
    },
  });

  const report = await service.diagnoseContribution({
    txHash: '0xabc123',
    contribution: {
      id: 'contrib-1',
      campaign_id: 'camp-1',
    },
  });

  assert.equal(report.tx_hash, '0xabc123');
  assert.equal(report.on_ledger, false);
  assert.equal(report.status, 'pending');
});

test('contributionDiagnostics - throws 502 with horizonUnreachable when Horizon lookup fails with non-404 error', async () => {
  const serverError = new Error('Gateway Timeout');
  serverError.response = { status: 504 };

  const { service, warnings } = createDiagnosticsService({
    transactionCall: async () => {
      throw serverError;
    },
  });

  await assert.rejects(
    async () => {
      await service.diagnoseContribution({
        txHash: '0xfail123',
      });
    },
    err => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.horizonUnreachable, true);
      assert.match(err.message, /Unable to reach Horizon for contribution diagnosis/);
      return true;
    }
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.txHash, '0xfail123');
  assert.equal(warnings[0].meta.error, 'Gateway Timeout');
});

test('contributionDiagnostics - handles successful payment operation on ledger', async () => {
  const mockTx = {
    successful: true,
    ledger: 987654,
    created_at: '2026-03-30T10:00:00Z',
    operations: [
      {
        type: 'payment',
        amount: '100.0000000',
        asset_type: 'native',
      },
    ],
  };

  const { service } = createDiagnosticsService({
    transactionCall: async () => mockTx,
  });

  const report = await service.diagnoseContribution({
    txHash: '0xsuccess_payment',
    contribution: { id: 'c-1', campaign_id: 'camp-1' },
  });

  assert.equal(report.on_ledger, true);
  assert.equal(report.status, service.STATUS_COMPLETED);
  assert.equal(report.tx_successful, true);
  assert.equal(report.ledger, 987654);
  assert.equal(report.created_at, '2026-03-30T10:00:00Z');
  assert.equal(report.path_hops, null);
  assert.equal(report.effective_rate, '1');
  assert.equal(report.source_amount, '100.0000000');
  assert.equal(report.destination_amount, '100.0000000');
});

test('contributionDiagnostics - marks status failed if transaction failed on ledger', async () => {
  const mockTx = {
    successful: false,
    ledger: 111111,
    created_at: '2026-03-30T11:00:00Z',
    operations: [
      {
        type: 'payment',
        amount: '50.0000000',
      },
    ],
  };

  const { service } = createDiagnosticsService({
    transactionCall: async () => mockTx,
  });

  const report = await service.diagnoseContribution({
    txHash: '0xfailed_tx',
  });

  assert.equal(report.on_ledger, true);
  assert.equal(report.status, service.STATUS_FAILED);
  assert.equal(report.tx_successful, false);
});

test('contributionDiagnostics - handles path payment and computes effective rate and path hops', async () => {
  const mockTx = {
    successful: true,
    ledger: 222222,
    created_at: '2026-03-30T12:00:00Z',
    operations: [
      {
        type: 'path_payment_strict_receive',
        source_amount: '20.0000000',
        destination_amount: '10.0000000',
        path: [
          { asset_type: 'native' },
          { asset_type: 'credit_alphanum4', asset_code: 'USDC' },
          { asset_type: 'credit_alphanum12', asset_code: 'EURC' },
        ],
      },
    ],
  };

  const { service } = createDiagnosticsService({
    transactionCall: async () => mockTx,
  });

  const report = await service.diagnoseContribution({
    txHash: '0xpath_tx',
  });

  assert.equal(report.on_ledger, true);
  assert.equal(report.status, service.STATUS_COMPLETED);
  assert.deepEqual(report.path_hops, ['XLM', 'USDC', 'EURC']);
  assert.equal(report.effective_rate, '2');
  assert.equal(report.source_amount, '20.0000000');
  assert.equal(report.destination_amount, '10.0000000');
});

test('contributionDiagnostics - computes actual slippage against quoted rate', async () => {
  // Quoted: 20 source for 10 dest -> quotedRate = 2.0
  // Actual: 21 source for 10 dest -> actualRate = 2.1
  // Slippage = ((2.1 - 2.0) / 2.0) * 10000 = (0.1 / 2.0) * 10000 = 500 bps (5%)
  const mockTx = {
    successful: true,
    ledger: 333333,
    operations: [
      {
        type: 'path_payment_strict_receive',
        source_amount: '21.0000000',
        destination_amount: '10.0000000',
        path: [{ asset_type: 'native' }],
      },
    ],
  };

  const { service } = createDiagnosticsService({
    transactionCall: async () => mockTx,
  });

  const report = await service.diagnoseContribution({
    txHash: '0xslippage_tx',
    metadata: {
      quoted_source_amount: '20.0000000',
      dest_amount: '10.0000000',
    },
  });

  assert.equal(report.actual_slippage_bps, 500);
});

test('contributionDiagnostics - clamps negative slippage to 0 when actual rate is better than quoted', async () => {
  // Quoted: 20 source for 10 dest -> quotedRate = 2.0
  // Actual: 19 source for 10 dest -> actualRate = 1.9 (favorable rate)
  const mockTx = {
    successful: true,
    operations: [
      {
        type: 'path_payment_strict_send',
        source_amount: '19.0000000',
        destination_amount: '10.0000000',
      },
    ],
  };

  const { service } = createDiagnosticsService({
    transactionCall: async () => mockTx,
  });

  const report = await service.diagnoseContribution({
    txHash: '0xfavorable_tx',
    metadata: {
      max_send_amount: '20.0000000',
      dest_amount: '10.0000000',
    },
  });

  assert.equal(report.actual_slippage_bps, 0);
});
