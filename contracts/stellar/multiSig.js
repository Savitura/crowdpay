/**
 * [EXAMPLE / REFERENCE CODE ONLY]
 * multiSig.js
 *
 * Standalone developer script demonstrating multi-signature withdrawal transactions.
 * Not used in production runtime. Production multisig logic is in backend/src/services/campaignMultisig.js.
 *
 * A withdrawal from a campaign wallet requires signatures from both
 * the campaign creator and the platform.
 *
 * Flow:
 *   1. Platform builds the unsigned XDR and stores it in DB
 *   2. Creator fetches and signs it (this script or frontend)
 *   3. Platform countersigns and submits
 *
 * Usage:
 *   node contracts/stellar/multiSig.js --build <walletPublicKey> <destPublicKey> <amount> <asset>
 *   node contracts/stellar/multiSig.js --sign <xdr> <signerSecret>
 *   node contracts/stellar/multiSig.js --submit <xdr>
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
  Transaction,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  Horizon,
} = require("./sdk").loadStellarSdk();

// Authoritative values live in backend/src/config/constants.js
const TX_TIMEOUT_WITHDRAWAL_S = 300; // 5 minutes for standalone CLI script; backend uses 7-day TX_TIMEOUT_WITHDRAWAL_S

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

function resolveAsset(assetCode) {
  return assetCode === "XLM"
    ? Asset.native()
    : new Asset("USDC", process.env.USDC_ISSUER);
}

/**
 * Build the unsigned withdrawal transaction the creator signs.
 * Returns the built transaction; the caller decides what to do with the XDR.
 */
async function buildWithdrawal(
  walletPublicKey,
  destPublicKey,
  amount,
  assetCode,
  server = getServer(),
) {
  const account = await server.loadAccount(walletPublicKey);
  const asset = resolveAsset(assetCode);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destPublicKey,
        asset,
        amount: String(amount),
      }),
    )
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S)
    .build();

  console.log("Unsigned withdrawal XDR:");
  console.log(tx.toXDR());
  console.log("\nShare this XDR with the campaign creator to sign.");

  return tx;
}

/** Add one signature and return the signed XDR. */
function signTransaction(xdr, signerSecret) {
  const tx = new Transaction(xdr, networkPassphrase);
  const keypair = Keypair.fromSecret(signerSecret);
  tx.sign(keypair);
  const signed = tx.toXDR();
  console.log("Signed XDR:");
  console.log(signed);
  return signed;
}

/** Add the platform signature and submit. */
async function submitTransaction(xdr, server = getServer()) {
  const tx = new Transaction(xdr, networkPassphrase);
  const platformKeypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
  tx.sign(platformKeypair);

  const result = await server.submitTransaction(tx);
  console.log("Withdrawal submitted.");
  console.log("Tx hash:", result.hash);
  return result;
}

module.exports = {
  TX_TIMEOUT_WITHDRAWAL_S,
  buildWithdrawal,
  signTransaction,
  submitTransaction,
};

if (require.main === module) {
  const [, , flag, ...args] = process.argv;

  if (flag === "--build")
    buildWithdrawal(args[0], args[1], args[2], args[3]).catch(console.error);
  else if (flag === "--sign") signTransaction(args[0], args[1]);
  else if (flag === "--submit") submitTransaction(args[0]).catch(console.error);
  else {
    console.log("Usage:");
    console.log(
      "  node multiSig.js --build <walletPublicKey> <destPublicKey> <amount> <asset>",
    );
    console.log("  node multiSig.js --sign <xdr> <signerSecret>");
    console.log("  node multiSig.js --submit <signedXdr>");
  }
}