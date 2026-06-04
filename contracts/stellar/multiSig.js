/**
 * multiSig.js
 *
 * Builds and submits multi-signature withdrawal transactions.
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

require('dotenv').config({ path: '../../backend/.env' });

const {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  Horizon,
} = require('@stellar/stellar-sdk');

// Authoritative values live in backend/src/config/constants.js
const TX_TIMEOUT_WITHDRAWAL_S = 300; // 5 minutes for standalone CLI script; backend uses 7-day TX_TIMEOUT_WITHDRAWAL_S

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);
const networkPassphrase = Networks.TESTNET;
const USDC = new Asset('USDC', process.env.USDC_ISSUER);

async function buildWithdrawal(walletPublicKey, destPublicKey, amount, assetCode) {
  const account = await server.loadAccount(walletPublicKey);
  const asset = assetCode === 'XLM' ? Asset.native() : USDC;

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.payment({ destination: destPublicKey, asset, amount: String(amount) })
    )
    .setTimeout(TX_TIMEOUT_WITHDRAWAL_S)
    .build();

  const xdr = tx.toXDR();
  console.log('Unsigned withdrawal XDR:');
  console.log(xdr);
  console.log('\nShare this XDR with the campaign creator to sign.');
}

function signTransaction(xdr, signerSecret) {
  const tx = new Transaction(xdr, networkPassphrase);
  const keypair = Keypair.fromSecret(signerSecret);
  tx.sign(keypair);
  const signed = tx.toXDR();
  console.log('Signed XDR:');
  console.log(signed);
}

async function submitTransaction(xdr) {
  // Add platform signature before submitting
  const tx = new Transaction(xdr, networkPassphrase);
  const platformKeypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
  tx.sign(platformKeypair);

  const result = await server.submitTransaction(tx);
  console.log('Withdrawal submitted.');
  console.log('Tx hash:', result.hash);
}

const [,, flag, ...args] = process.argv;

if (flag === '--build') buildWithdrawal(args[0], args[1], args[2], args[3]).catch(console.error);
else if (flag === '--sign') signTransaction(args[0], args[1]);
else if (flag === '--submit') submitTransaction(args[0]).catch(console.error);
else {
  console.log('Usage:');
  console.log('  node multiSig.js --build <walletPublicKey> <destPublicKey> <amount> <asset>');
  console.log('  node multiSig.js --sign <xdr> <signerSecret>');
  console.log('  node multiSig.js --submit <signedXdr>');
}
