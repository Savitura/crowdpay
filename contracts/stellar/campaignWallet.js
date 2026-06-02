/**
 * campaignWallet.js
 *
 * Standalone scripts for campaign wallet management.
 * Run directly with Node.js for setup and debugging.
 *
 * Usage:
 *   node contracts/stellar/campaignWallet.js --setup-platform
 *   node contracts/stellar/campaignWallet.js --create <creatorPublicKey>
 *   node contracts/stellar/campaignWallet.js --inspect <walletPublicKey>
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

// ─── Setup Platform Account ────────────────────────────────────────────────

async function setupPlatformAccount() {
  const keypair = Keypair.random();

  console.log('Generated platform keypair:');
  console.log('  Public key:', keypair.publicKey());
  console.log('  Secret key:', keypair.secret());
  console.log('\nFunding via Friendbot…');

  const res = await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`);
  await res.json();

  const account = await server.loadAccount(keypair.publicKey());
  console.log('\nPlatform account funded.');
  console.log('Balances:', account.balances);
  console.log('\nAdd to backend/.env:');
  console.log(`PLATFORM_PUBLIC_KEY=${keypair.publicKey()}`);
  console.log(`PLATFORM_SECRET_KEY=${keypair.secret()}`);
}

// ─── Create Campaign Wallet ────────────────────────────────────────────────

async function createCampaignWallet(creatorPublicKey) {
  if (!process.env.PLATFORM_SECRET_KEY) throw new Error('PLATFORM_SECRET_KEY not set');

  const platformKeypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
  const campaignKeypair = Keypair.random();

  console.log('New campaign wallet:', campaignKeypair.publicKey());
  console.log('Funding from platform account…');

  const platformAccount = await server.loadAccount(platformKeypair.publicKey());

  // Step 1: Fund the campaign account
  const fundTx = new TransactionBuilder(platformAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.createAccount({
        destination: campaignKeypair.publicKey(),
        startingBalance: '2',
      })
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  fundTx.sign(platformKeypair);
  await server.submitTransaction(fundTx);
  console.log('Campaign account funded.');

  // Step 2: Configure multisig + trustline
  const campaignAccount = await server.loadAccount(campaignKeypair.publicKey());

  const setupTx = new TransactionBuilder(campaignAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: creatorPublicKey, weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: platformKeypair.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  setupTx.sign(campaignKeypair);
  await server.submitTransaction(setupTx);

  console.log('\nCampaign wallet configured:');
  console.log('  Public key:', campaignKeypair.publicKey());
  console.log('  USDC trustline: established');
  console.log('  Signers: creator + platform (threshold 2)');
  console.log('  Master key: disabled');
}

// ─── Inspect Wallet ────────────────────────────────────────────────────────

async function inspectWallet(publicKey) {
  const account = await server.loadAccount(publicKey);
  console.log('Account:', publicKey);
  console.log('Balances:', account.balances);
  console.log('Signers:', account.signers);
  console.log('Thresholds:', account.thresholds);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const [,, flag, arg] = process.argv;

if (flag === '--setup-platform') setupPlatformAccount().catch(console.error);
else if (flag === '--create') createCampaignWallet(arg).catch(console.error);
else if (flag === '--inspect') inspectWallet(arg).catch(console.error);
else {
  console.log('Usage:');
  console.log('  node campaignWallet.js --setup-platform');
  console.log('  node campaignWallet.js --create <creatorPublicKey>');
  console.log('  node campaignWallet.js --inspect <walletPublicKey>');
}
