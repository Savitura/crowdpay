const { Horizon, Networks, Asset } = require('@stellar/stellar-sdk');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

const networkPassphrase = isTestnet ? Networks.TESTNET : Networks.PUBLIC;

// USDC asset — issuer differs between testnet and mainnet
const USDC = process.env.USDC_ISSUER ? new Asset('USDC', process.env.USDC_ISSUER) : null;

function parseAdditionalAssets() {
  if (!process.env.STELLAR_EXTRA_ASSETS) return {};
  try {
    const parsed = JSON.parse(process.env.STELLAR_EXTRA_ASSETS);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    throw new Error('STELLAR_EXTRA_ASSETS must be valid JSON object: {"CODE":"ISSUER"}');
  }
}

const configuredAssets = {
  XLM: { type: 'native' },
  USDC: { type: 'credit_alphanum4', issuer: process.env.USDC_ISSUER },
};

if (process.env.NGN_ISSUER) {
  configuredAssets.NGN = { type: 'credit_alphanum4', issuer: process.env.NGN_ISSUER };
}

for (const [code, issuer] of Object.entries(parseAdditionalAssets())) {
  if (code === 'XLM' || code === 'USDC') continue;
  configuredAssets[code] = { type: 'credit_alphanum12', issuer };
}

module.exports = {
  server,
  networkPassphrase,
  USDC,
  isTestnet,
  configuredAssets,
};
