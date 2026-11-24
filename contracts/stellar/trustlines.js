/**
 * [EXAMPLE / REFERENCE CODE ONLY]
 * trustlines.js
 *
 * Standalone developer script demonstrating Stellar asset trustlines.
 * Not used in production runtime. Production trustline management is in backend/src/services/stellarService.js.
 *
 * Utility to establish and inspect Stellar asset trustlines.
 * Trustlines must exist before an account can receive a non-native asset.
 *
 * Usage:
 *   node contracts/stellar/trustlines.js --add <accountSecret> <assetCode> <issuerPublicKey>
 *   node contracts/stellar/trustlines.js --check <accountPublicKey> <assetCode>
 */

require("dotenv").config({
  path: require("path").join(__dirname, "../../backend/.env"),
});

const {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
} = require("@stellar/stellar-sdk");
const { getHorizonServer, getNetworkPassphrase } = require("./horizon");

// Authoritative value lives in backend/src/config/constants.js TX_TIMEOUT_CONTRIBUTION_S
const TX_TIMEOUT_CONTRIBUTION_S = 30;

async function addTrustline(accountSecret, assetCode, issuerPublicKey, options = {}) {
  const server = getHorizonServer(options);
  const keypair = Keypair.fromSecret(accountSecret);
  const account = await server.loadAccount(keypair.publicKey());
  const asset = new Asset(assetCode, issuerPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(options),
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  console.log(`Trustline established for ${assetCode}:${issuerPublicKey}`);
  console.log("Tx hash:", result.hash);
  return result;
}

async function checkTrustline(publicKey, assetCode, options = {}) {
  const server = getHorizonServer(options);
  const account = await server.loadAccount(publicKey);
  const trusted = account.balances.find((b) => b.asset_code === assetCode);
  if (trusted) {
    console.log(`${assetCode} trustline found. Balance: ${trusted.balance}`);
  } else {
    console.log(`No trustline for ${assetCode} on this account.`);
  }
  return trusted || null;
}

function createClient(options = {}) {
  return {
    addTrustline: (...args) => addTrustline(...args, options),
    checkTrustline: (...args) => checkTrustline(...args, options),
    getServer: (overrides) => getHorizonServer({ ...options, ...overrides }),
  };
}

if (require.main === module) {
  const [, , flag, ...args] = process.argv;

  if (flag === "--add")
    addTrustline(args[0], args[1], args[2]).catch(console.error);
  else if (flag === "--check")
    checkTrustline(args[0], args[1]).catch(console.error);
  else {
    console.log("Usage:");
    console.log(
      "  node trustlines.js --add <accountSecret> <assetCode> <issuerPublicKey>",
    );
    console.log("  node trustlines.js --check <accountPublicKey> <assetCode>");
  }
}

module.exports = {
  addTrustline,
  checkTrustline,
  createClient,
  getServer: getHorizonServer,
};
