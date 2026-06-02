/**
 * pathPayment.js
 *
 * Demonstrates and tests Stellar path payments.
 * A path payment lets a contributor send XLM while the campaign receives USDC.
 * Stellar's DEX finds the conversion path automatically.
 *
 * Usage:
 *   node contracts/stellar/pathPayment.js --quote <sendAsset> <sendAmount> <destAsset>
 *   node contracts/stellar/pathPayment.js --send <senderSecret> <destPublicKey> <sendAsset> <sendMax> <destAmount>
 */

require('dotenv').config({ path: '../../backend/.env' });

const {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  Horizon,
} = require('@stellar/stellar-sdk');

// Authoritative value lives in backend/src/config/constants.js TX_TIMEOUT_CONTRIBUTION_S
const TX_TIMEOUT_CONTRIBUTION_S = 30;

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);
const networkPassphrase = Networks.TESTNET;
const USDC = new Asset('USDC', process.env.USDC_ISSUER);

function resolveAsset(code) {
  if (code === 'XLM') return Asset.native();
  if (code === 'USDC') return USDC;
  throw new Error(`Unknown asset: ${code}`);
}

/**
 * Find the best path and estimate how much send asset is needed
 * to receive a given amount of the destination asset.
 */
async function quotePath(sendAssetCode, sendAmount, destAssetCode) {
  const sendAsset = resolveAsset(sendAssetCode);
  const destAsset = resolveAsset(destAssetCode);

  // Use Stellar's path finding endpoint
  const paths = await server
    .strictReceivePaths(sendAsset, destAsset, sendAmount)
    .call();

  if (!paths.records.length) {
    console.log('No path found. The DEX may not have liquidity for this pair on testnet.');
    return;
  }

  console.log(`Paths to receive ${sendAmount} ${destAssetCode} by sending ${sendAssetCode}:`);
  for (const p of paths.records) {
    console.log(`  Send at most: ${p.source_amount} ${sendAssetCode}`);
    console.log(`  Path: ${p.path.map((a) => a.asset_code || 'XLM').join(' → ') || 'direct'}`);
    console.log();
  }
}

/**
 * Execute a path payment.
 * destAmount is exact — the campaign always receives what it expects.
 * sendMax is the max the sender is willing to pay (slippage protection).
 */
async function sendPathPayment(senderSecret, destPublicKey, sendAssetCode, sendMax, destAmount) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const senderAccount = await server.loadAccount(senderKeypair.publicKey());
  const sendAsset = resolveAsset(sendAssetCode);

  const tx = new TransactionBuilder(senderAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset,
        sendMax: String(sendMax),
        destination: destPublicKey,
        destAsset: USDC,
        destAmount: String(destAmount),
        path: [], // let Stellar discover the path
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(senderKeypair);
  const result = await server.submitTransaction(tx);
  console.log('Path payment submitted.');
  console.log('Tx hash:', result.hash);
}

const [,, flag, ...args] = process.argv;

if (flag === '--quote') quotePath(args[0], args[1], args[2]).catch(console.error);
else if (flag === '--send') sendPathPayment(args[0], args[1], args[2], args[3], args[4]).catch(console.error);
else {
  console.log('Usage:');
  console.log('  node pathPayment.js --quote <sendAsset> <receiveAmount> <destAsset>');
  console.log('  node pathPayment.js --send <senderSecret> <destPublicKey> <sendAsset> <sendMax> <destAmount>');
}
