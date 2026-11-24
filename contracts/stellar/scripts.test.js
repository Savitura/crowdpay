const test = require("node:test");
const assert = require("node:assert/strict");
const { Asset, Horizon, Keypair, Networks, Transaction } = require("@stellar/stellar-sdk");

const { mock } = require("node:test");

function freshScripts() {
  for (const name of ["horizon", "multiSig", "pathPayment", "trustlines"]) {
    delete require.cache[require.resolve(`./${name}`)];
  }
  return {
    horizon: require("./horizon"),
    multiSig: require("./multiSig"),
    pathPayment: require("./pathPayment"),
    trustlines: require("./trustlines"),
  };
}

function makeServer(publicKey, balances) {
  const calls = { loadAccount: [], submitTransaction: [], strictReceivePaths: [] };
  const account = {
    accountId: () => publicKey,
    sequenceNumber: () => "1234",
    incrementSequenceNumber: () => {},
    balances,
  };
  const server = {
    loadAccount: async id => {
      calls.loadAccount.push(id);
      return account;
    },
    submitTransaction: async tx => {
      calls.submitTransaction.push(tx);
      return { hash: "mock-hash" };
    },
    strictReceivePaths: (sendAsset, destAsset, amount) => {
      calls.strictReceivePaths.push({ sendAsset, destAsset, amount });
      return {
        call: async () => ({
          records: [{ source_amount: "10", path: [] }],
        }),
      };
    },
  };
  return { server, calls };
}

test("example scripts import without CLI output or eager Horizon construction", () => {
  const OriginalServer = Horizon.Server;
  let constructed = 0;
  Horizon.Server = function (...args) {
    constructed += 1;
    return new OriginalServer(...args);
  };

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    freshScripts();
  } finally {
    console.log = originalLog;
    Horizon.Server = OriginalServer;
  }

  assert.equal(constructed, 0);
  assert.equal(logs.some(line => line.includes("Usage:")), false);
});

test("multiSig client uses the injected server, asset and network passphrase", async t => {
  mock.method(console, "log", () => {});
  t.after(() => mock.restoreAll());

  const { multiSig } = freshScripts();
  const publicKey = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const { server, calls } = makeServer(publicKey, []);
  const client = multiSig.createClient({
    server,
    usdc: new Asset("USDC", issuer),
    platformSecret: Keypair.random().secret(),
    networkPassphrase: Networks.PUBLIC,
  });

  const xdr = await client.buildWithdrawal(publicKey, destination, "1.5", "USDC");
  assert.deepEqual(calls.loadAccount, [publicKey]);

  const unsigned = new Transaction(xdr, Networks.PUBLIC);
  assert.equal(unsigned.networkPassphrase, Networks.PUBLIC);
  assert.equal(unsigned.operations[0].amount, "1.5000000");
  assert.equal(unsigned.operations[0].asset.code, "USDC");
  assert.equal(unsigned.operations[0].asset.issuer, issuer);

  const signed = client.signTransaction(xdr, Keypair.random().secret());
  assert.notEqual(signed, xdr);
  const result = await client.submitTransaction(signed);
  assert.equal(result.hash, "mock-hash");
  assert.equal(calls.submitTransaction.length, 1);
  assert.ok(calls.submitTransaction[0] instanceof Transaction);
  assert.equal(client.getServer(), server);
});

test("pathPayment client quotes and sends through an injected server", async t => {
  mock.method(console, "log", () => {});
  t.after(() => mock.restoreAll());

  const { pathPayment } = freshScripts();
  const publicKey = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const { server, calls } = makeServer(publicKey, []);
  const client = pathPayment.createClient({
    server,
    usdc: new Asset("USDC", issuer),
    networkPassphrase: Networks.PUBLIC,
  });

  const paths = await client.quotePath("XLM", "10", "USDC");
  assert.equal(paths.records.length, 1);
  assert.equal(calls.strictReceivePaths[0].amount, "10");
  assert.equal(calls.strictReceivePaths[0].destAsset.issuer, issuer);

  const result = await client.sendPathPayment(
    Keypair.random().secret(),
    publicKey,
    "XLM",
    "10",
    "1",
  );
  assert.equal(result.hash, "mock-hash");
  const submitted = calls.submitTransaction[0];
  assert.equal(submitted.operations[0].type, "pathPaymentStrictReceive");
  assert.equal(submitted.operations[0].destAsset.issuer, issuer);
  assert.equal(submitted.networkPassphrase, Networks.PUBLIC);
});

test("trustlines client inspects and adds trustlines through an injected server", async t => {
  mock.method(console, "log", () => {});
  t.after(() => mock.restoreAll());

  const { trustlines } = freshScripts();
  const publicKey = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const { server, calls } = makeServer(publicKey, [
    { asset_type: "native", balance: "10" },
    { asset_code: "USDC", asset_issuer: issuer, balance: "5" },
  ]);
  const client = trustlines.createClient({
    server,
    networkPassphrase: Networks.PUBLIC,
  });

  const trusted = await client.checkTrustline(publicKey, "USDC");
  assert.equal(trusted.balance, "5");
  assert.deepEqual(calls.loadAccount, [publicKey]);

  const result = await client.addTrustline(
    Keypair.random().secret(),
    "USDC",
    issuer,
  );
  assert.equal(result.hash, "mock-hash");
  assert.equal(calls.submitTransaction[0].operations[0].type, "changeTrust");
});

test("script clients build a lazy default server for the configured network", () => {
  const { multiSig, horizon } = freshScripts();
  horizon.resetHorizonServer();

  const mainnetClient = multiSig.createClient({
    env: { STELLAR_NETWORK: "mainnet" },
  });
  const server = mainnetClient.getServer();
  assert.ok(server instanceof Horizon.Server);
  assert.equal(server.serverURL.toString(), `${horizon.MAINNET_HORIZON_URL}/`);
});
