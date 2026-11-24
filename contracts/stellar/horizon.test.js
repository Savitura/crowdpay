const test = require("node:test");
const assert = require("node:assert/strict");
const { Horizon, Networks, Asset, Keypair } = require("@stellar/stellar-sdk");
const {
  TESTNET_HORIZON_URL,
  MAINNET_HORIZON_URL,
  isMainnet,
  getHorizonUrl,
  getNetworkPassphrase,
  createHorizonServer,
  getHorizonServer,
  resetHorizonServer,
  createUsdcAsset,
} = require("./horizon");

test("getHorizonUrl prefers explicit URL, then env, then network default", () => {
  assert.equal(getHorizonUrl({ env: {} }), TESTNET_HORIZON_URL);
  assert.equal(
    getHorizonUrl({ env: { STELLAR_NETWORK: "mainnet" } }),
    MAINNET_HORIZON_URL,
  );
  assert.equal(
    getHorizonUrl({
      env: {
        STELLAR_NETWORK: "mainnet",
        STELLAR_HORIZON_URL: "https://horizon.example.test",
      },
    }),
    "https://horizon.example.test",
  );
  assert.equal(
    getHorizonUrl({
      horizonUrl: "https://mock.example.test",
      env: { STELLAR_HORIZON_URL: "https://horizon.example.test" },
    }),
    "https://mock.example.test",
  );
  assert.equal(isMainnet({ STELLAR_NETWORK: "mainnet" }), true);
  assert.equal(isMainnet({ STELLAR_NETWORK: "testnet" }), false);
});

test("getNetworkPassphrase follows STELLAR_NETWORK unless overridden", () => {
  assert.equal(getNetworkPassphrase({ env: {} }), Networks.TESTNET);
  assert.equal(
    getNetworkPassphrase({ env: { STELLAR_NETWORK: "mainnet" } }),
    Networks.PUBLIC,
  );
  assert.equal(
    getNetworkPassphrase({ networkPassphrase: "custom passphrase", env: {} }),
    "custom passphrase",
  );
});

test("createHorizonServer builds a client for the chosen URL or reuses an injected one", () => {
  const injected = { server: "mock" };
  assert.equal(createHorizonServer({ server: injected }), injected);

  const created = createHorizonServer({ horizonUrl: "https://mock.example.test" });
  assert.ok(created instanceof Horizon.Server);
  assert.equal(created.serverURL.toString(), "https://mock.example.test/");
});

test("getHorizonServer caches per URL and reset clears the cache", () => {
  resetHorizonServer();
  const first = getHorizonServer({ horizonUrl: "https://first.example.test" });
  const same = getHorizonServer({ horizonUrl: "https://first.example.test" });
  const other = getHorizonServer({ horizonUrl: "https://second.example.test" });
  assert.equal(same, first);
  assert.notEqual(other, first);

  resetHorizonServer();
  assert.notEqual(
    getHorizonServer({ horizonUrl: "https://first.example.test" }),
    first,
  );
});

test("createUsdcAsset resolves the issuer lazily and accepts an injected asset", () => {
  const issuer = Keypair.random().publicKey();
  const asset = createUsdcAsset({ env: { USDC_ISSUER: issuer } });
  assert.ok(asset instanceof Asset);
  assert.equal(asset.code, "USDC");
  assert.equal(asset.issuer, issuer);

  const injected = { code: "USDC" };
  assert.equal(createUsdcAsset({ usdc: injected, env: {} }), injected);
});
