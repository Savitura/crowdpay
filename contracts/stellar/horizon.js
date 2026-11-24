/**
 * horizon.js
 *
 * Shared Horizon client configuration for the standalone Stellar example
 * scripts. Servers are created on demand (never at module load) so callers can
 * target mainnet, testnet, or an injected mock server.
 */

const { Horizon, Networks, Asset } = require("@stellar/stellar-sdk");

const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const MAINNET_HORIZON_URL = "https://horizon.stellar.org";

let cachedServer = null;
let cachedUrl = null;

function isMainnet(env = process.env) {
  return env.STELLAR_NETWORK === "mainnet";
}

function getHorizonUrl(options = {}) {
  const env = options.env || process.env;
  return (
    options.horizonUrl ||
    env.STELLAR_HORIZON_URL ||
    (isMainnet(env) ? MAINNET_HORIZON_URL : TESTNET_HORIZON_URL)
  );
}

function getNetworkPassphrase(options = {}) {
  const env = options.env || process.env;
  return options.networkPassphrase || (isMainnet(env) ? Networks.PUBLIC : Networks.TESTNET);
}

function createHorizonServer(options = {}) {
  if (options.server) return options.server;
  return new Horizon.Server(getHorizonUrl(options));
}

function getHorizonServer(options = {}) {
  if (options.server) return options.server;
  const url = getHorizonUrl(options);
  if (!cachedServer || cachedUrl !== url) {
    cachedServer = new Horizon.Server(url);
    cachedUrl = url;
  }
  return cachedServer;
}

function resetHorizonServer() {
  cachedServer = null;
  cachedUrl = null;
}

function createUsdcAsset(options = {}) {
  const env = options.env || process.env;
  return options.usdc || new Asset("USDC", env.USDC_ISSUER);
}

module.exports = {
  TESTNET_HORIZON_URL,
  MAINNET_HORIZON_URL,
  isMainnet,
  getHorizonUrl,
  getNetworkPassphrase,
  createHorizonServer,
  getHorizonServer,
  resetHorizonServer,
  createUsdcAsset,
};
