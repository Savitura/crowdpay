const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Account,
  Keypair,
  Networks,
  Transaction,
} = require('@stellar/stellar-sdk');

const multiSig = require('../../../contracts/stellar/multiSig');
const pathPayment = require('../../../contracts/stellar/pathPayment');
const trustlines = require('../../../contracts/stellar/trustlines');

const ISSUER = Keypair.random().publicKey();
const WALLET = Keypair.random();
const DESTINATION = Keypair.random();
const SENDER = Keypair.random();
const CREATOR = Keypair.random();

process.env.USDC_ISSUER = process.env.USDC_ISSUER || ISSUER;
process.env.PLATFORM_SECRET_KEY =
  process.env.PLATFORM_SECRET_KEY || Keypair.random().secret();

function accountFor(keypair) {
  return new Account(keypair.publicKey(), '100');
}

/** Stub of the Horizon surface these scripts use; records submitted transactions. */
function fakeServer({ paths = [], balances = [], hash = 'abc123' } = {}) {
  const submitted = [];
  return {
    submitted,
    loadAccount: async () => Object.assign(accountFor(WALLET), { balances }),
    strictReceivePaths: (sendAsset, destAsset, amount) => ({
      call: async () => {
        submitted.push({ kind: 'quote', sendAsset, destAsset, amount });
        return { records: paths };
      },
    }),
    submitTransaction: async (tx) => {
      submitted.push(tx);
      return { hash };
    },
  };
}

test('buildWithdrawal builds a native XLM payment to the destination', async () => {
  const server = fakeServer();
  const tx = await multiSig.buildWithdrawal(
    WALLET.publicKey(),
    DESTINATION.publicKey(),
    '12.5',
    'XLM',
    server,
  );

  const op = tx.operations[0];
  assert.equal(op.type, 'payment');
  assert.equal(op.destination, DESTINATION.publicKey());
  assert.equal(Number(op.amount), 12.5, 'amount is sent as a 7-decimal Stellar amount');
  assert.equal(op.asset.isNative(), true);
  assert.equal(tx.toXDR().length > 0, true);
});

test('buildWithdrawal uses the configured USDC issuer for USDC withdrawals', async () => {
  const server = fakeServer();
  const tx = await multiSig.buildWithdrawal(
    WALLET.publicKey(),
    DESTINATION.publicKey(),
    '5',
    'USDC',
    server,
  );

  const op = tx.operations[0];
  assert.equal(op.asset.getCode(), 'USDC');
  assert.equal(op.asset.getIssuer(), process.env.USDC_ISSUER);
});

test('signTransaction adds exactly one signature', async () => {
  const built = await multiSig.buildWithdrawal(
    WALLET.publicKey(),
    DESTINATION.publicKey(),
    '1',
    'XLM',
    fakeServer(),
  );

  const signed = multiSig.signTransaction(built.toXDR(), CREATOR.secret());
  const parsed = new Transaction(signed, Networks.TESTNET);
  assert.equal(parsed.signatures.length, 1);
});

test('submitTransaction adds the platform signature and submits once', async () => {
  const server = fakeServer({ hash: 'withdrawal-hash' });
  const built = await multiSig.buildWithdrawal(
    WALLET.publicKey(),
    DESTINATION.publicKey(),
    '3',
    'XLM',
    server,
  );
  const signedByCreator = multiSig.signTransaction(built.toXDR(), CREATOR.secret());

  const result = await multiSig.submitTransaction(signedByCreator, server);

  assert.equal(result.hash, 'withdrawal-hash');
  assert.equal(server.submitted.length, 1);
  assert.equal(server.submitted[0].signatures.length, 2);
});

test('resolveAsset maps XLM, USDC and rejects unknown codes', () => {
  assert.equal(pathPayment.resolveAsset('XLM').isNative(), true);
  assert.equal(pathPayment.resolveAsset('USDC').getCode(), 'USDC');
  assert.throws(() => pathPayment.resolveAsset('BTC'), /Unknown asset: BTC/);
});

test('quotePath returns the DEX path records and asks for a strict receive quote', async () => {
  const record = {
    source_amount: '9.5',
    path: [{ asset_code: 'USDC' }],
  };
  const server = fakeServer({ paths: [record] });

  const records = await pathPayment.quotePath('XLM', '10', 'USDC', server);

  assert.deepEqual(records, [record]);
  const quote = server.submitted[0];
  assert.equal(quote.kind, 'quote');
  assert.equal(quote.sendAsset.isNative(), true);
  assert.equal(quote.destAsset.getCode(), 'USDC');
  assert.equal(quote.amount, '10');
});

test('quotePath returns an empty list when no path exists', async () => {
  const records = await pathPayment.quotePath('XLM', '10', 'USDC', fakeServer());
  assert.deepEqual(records, []);
});

test('sendPathPayment builds a strict-receive path payment with slippage protection', async () => {
  const server = fakeServer({ hash: 'path-hash' });

  const result = await pathPayment.sendPathPayment(
    SENDER.secret(),
    DESTINATION.publicKey(),
    'XLM',
    '11.5',
    '10',
    server,
  );

  assert.equal(result.hash, 'path-hash');
  assert.equal(server.submitted.length, 1);

  const op = server.submitted[0].operations[0];
  assert.equal(op.type, 'pathPaymentStrictReceive');
  assert.equal(op.sendAsset.isNative(), true);
  assert.equal(Number(op.sendMax), 11.5, 'sendMax caps what the sender pays');
  assert.equal(Number(op.destAmount), 10, 'the campaign receives exactly destAmount');
  assert.equal(op.destAsset.getCode(), 'USDC');
  assert.deepEqual(op.path, []);
  assert.equal(server.submitted[0].signatures.length, 1);
});

test('findTrustline finds the matching asset and tolerates missing data', () => {
  const balances = [
    { asset_type: 'native' },
    { asset_code: 'USDC', balance: '42.5' },
  ];

  assert.equal(trustlines.findTrustline(balances, 'USDC').balance, '42.5');
  assert.equal(trustlines.findTrustline(balances, 'EURT'), undefined);
  assert.equal(trustlines.findTrustline(undefined, 'USDC'), undefined);
});

test('addTrustline submits a changeTrust operation for the asset', async () => {
  const server = fakeServer({ hash: 'trust-hash' });

  const result = await trustlines.addTrustline(
    WALLET.secret(),
    'USDC',
    ISSUER,
    server,
  );

  assert.equal(result.hash, 'trust-hash');
  const op = server.submitted[0].operations[0];
  assert.equal(op.type, 'changeTrust');
  assert.equal(op.line.getCode(), 'USDC');
  assert.equal(op.line.getIssuer(), ISSUER);
  assert.equal(server.submitted[0].signatures.length, 1);
});

test('checkTrustline validates the account balances', async () => {
  const withTrustline = fakeServer({ balances: [{ asset_code: 'USDC', balance: '1' }] });
  const withoutTrustline = fakeServer({ balances: [{ asset_type: 'native' }] });

  assert.equal(await trustlines.checkTrustline(WALLET.publicKey(), 'USDC', withTrustline), true);
  assert.equal(
    await trustlines.checkTrustline(WALLET.publicKey(), 'USDC', withoutTrustline),
    false,
  );
});
