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

try {
  // Optional: the example CLIs also read plain environment variables.
  require("dotenv").config({ path: "../../backend/.env" });
} catch {
  // dotenv is not installed for every checkout; the process env still works.
}

const {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  Horizon,
} = require("./sdk").loadStellarSdk();

// Authoritative value lives in backend/src/config/constants.js TX_TIMEOUT_CONTRIBUTION_S
const TX_TIMEOUT_CONTRIBUTION_S = 30;

const networkPassphrase = Networks.TESTNET;

let horizonServer = null;

/** Lazily create the Horizon client so importing this module never hits the network. */
function getServer() {
  if (!horizonServer) {
    horizonServer = new Horizon.Server(
      process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
    );
  }
  return horizonServer;
}

/** Returns the balance entry for `assetCode`, or undefined when there is no trustline. */
function findTrustline(balances, assetCode) {
  if (!Array.isArray(balances)) return undefined;
  return balances.find((balance) => balance.asset_code === assetCode);
}

/** Establish a trustline and submit it. */
async function addTrustline(
  accountSecret,
  assetCode,
  issuerPublicKey,
  server = getServer(),
) {
  const keypair = Keypair.fromSecret(accountSecret);
  const account = await server.loadAccount(keypair.publicKey());
  const asset = new Asset(assetCode, issuerPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
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

/** Report whether the account holds a trustline for `assetCode`. */
async function checkTrustline(publicKey, assetCode, server = getServer()) {
  const account = await server.loadAccount(publicKey);
  const trusted = findTrustline(account.balances, assetCode);
  if (trusted) {
    console.log(`${assetCode} trustline found. Balance: ${trusted.balance}`);
    return true;
  }
  console.log(`No trustline for ${assetCode} on this account.`);
  return false;
}

module.exports = {
  TX_TIMEOUT_CONTRIBUTION_S,
  findTrustline,
  addTrustline,
  checkTrustline,
};

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