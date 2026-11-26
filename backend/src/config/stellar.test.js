const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Networks } = require('@stellar/stellar-sdk');

const STELLAR_PATH = path.join(__dirname, 'stellar.js');
const ENV_KEYS = [
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'USDC_ISSUER',
  'NGN_ISSUER',
  'STELLAR_EXTRA_ASSETS',
];
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NGN_ISSUER = 'GCQOTJ6XHGDV3CSAUPMOP5UGMTGRCYZLTWI2EZSRKMZVPV7Q5FYFSAX6';
const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';

/** Loads a fresh copy of stellar.js with only the given Stellar env vars set. */
function loadStellar(env = {}) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.USDC_ISSUER = USDC_ISSUER;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete require.cache[STELLAR_PATH];
  try {
    return require(STELLAR_PATH);
  } finally {
    delete require.cache[STELLAR_PATH];
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('stellar: defaults to testnet when STELLAR_NETWORK is unset', () => {
  const stellar = loadStellar();
  assert.equal(stellar.isTestnet, true);
  assert.equal(stellar.networkPassphrase, Networks.TESTNET);
});

test('stellar: STELLAR_NETWORK=testnet selects the testnet passphrase', () => {
  const stellar = loadStellar({ STELLAR_NETWORK: 'testnet' });
  assert.equal(stellar.isTestnet, true);
  assert.equal(stellar.networkPassphrase, 'Test SDF Network ; September 2015');
});

test('stellar: STELLAR_NETWORK=mainnet selects the public network passphrase', () => {
  const stellar = loadStellar({
    STELLAR_NETWORK: 'mainnet',
    STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
  });
  assert.equal(stellar.isTestnet, false);
  assert.equal(stellar.networkPassphrase, Networks.PUBLIC);
  assert.equal(stellar.networkPassphrase, 'Public Global Stellar Network ; September 2015');
});

test('stellar: any value other than "mainnet" stays on testnet (fails safe)', () => {
  for (const value of ['MAINNET', 'public', 'main', '']) {
    const stellar = loadStellar({ STELLAR_NETWORK: value });
    assert.equal(stellar.isTestnet, true, `STELLAR_NETWORK=${JSON.stringify(value)}`);
    assert.equal(stellar.networkPassphrase, Networks.TESTNET);
  }
});

test('stellar: uses the testnet Horizon URL when STELLAR_HORIZON_URL is missing or empty', () => {
  for (const url of [undefined, '']) {
    const { server } = loadStellar({ STELLAR_HORIZON_URL: url });
    assert.equal(server.serverURL.toString(), 'https://horizon-testnet.stellar.org/');
  }
});

test('stellar: uses a configured https Horizon URL', () => {
  const { server } = loadStellar({ STELLAR_HORIZON_URL: 'https://horizon.example.com/' });
  assert.equal(server.serverURL.toString(), 'https://horizon.example.com/');
});

test('stellar: rejects insecure or malformed Horizon URLs at load time', () => {
  for (const url of ['http://horizon.example.com', 'horizon.example.com', 'not a url']) {
    assert.throws(
      () => loadStellar({ STELLAR_HORIZON_URL: url }),
      /Cannot connect to insecure horizon server/,
      `STELLAR_HORIZON_URL=${JSON.stringify(url)}`
    );
  }
});

test('stellar: builds the USDC asset from USDC_ISSUER', () => {
  const { USDC } = loadStellar();
  assert.equal(USDC.getCode(), 'USDC');
  assert.equal(USDC.getIssuer(), USDC_ISSUER);
});

test('stellar: rejects a missing or invalid USDC_ISSUER', () => {
  assert.throws(() => loadStellar({ USDC_ISSUER: undefined }), /Issuer cannot be null/);
  assert.throws(() => loadStellar({ USDC_ISSUER: 'not-a-key' }), /Issuer is invalid/);
});

test('stellar: configuredAssets always contains XLM and USDC', () => {
  const { configuredAssets } = loadStellar();
  assert.deepEqual(configuredAssets, {
    XLM: { type: 'native' },
    USDC: { type: 'credit_alphanum4', issuer: USDC_ISSUER },
  });
});

test('stellar: NGN is added only when NGN_ISSUER is set', () => {
  const { configuredAssets } = loadStellar({ NGN_ISSUER });
  assert.deepEqual(configuredAssets.NGN, { type: 'credit_alphanum4', issuer: NGN_ISSUER });
});

test('stellar: STELLAR_EXTRA_ASSETS adds assets but cannot override XLM or USDC', () => {
  const { configuredAssets } = loadStellar({
    STELLAR_EXTRA_ASSETS: JSON.stringify({
      EURC: EURC_ISSUER,
      XLM: EURC_ISSUER,
      USDC: EURC_ISSUER,
    }),
  });
  assert.deepEqual(configuredAssets.EURC, { type: 'credit_alphanum12', issuer: EURC_ISSUER });
  assert.deepEqual(configuredAssets.XLM, { type: 'native' });
  assert.equal(configuredAssets.USDC.issuer, USDC_ISSUER);
});

test('stellar: non-object STELLAR_EXTRA_ASSETS JSON is ignored', () => {
  for (const value of ['null', '42', '"EURC"']) {
    const { configuredAssets } = loadStellar({ STELLAR_EXTRA_ASSETS: value });
    assert.deepEqual(Object.keys(configuredAssets).sort(), ['USDC', 'XLM']);
  }
});

test('stellar: malformed STELLAR_EXTRA_ASSETS JSON fails loudly', () => {
  assert.throws(
    () => loadStellar({ STELLAR_EXTRA_ASSETS: '{EURC:' }),
    /STELLAR_EXTRA_ASSETS must be valid JSON object/
  );
});
