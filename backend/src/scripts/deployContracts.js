/**
 * deployContracts.js
 *
 * Deploys Soroban escrow and milestones contracts to Stellar testnet.
 * Uses the `stellar` CLI tool.
 *
 * Usage:
 *   cd contracts/soroban
 *   cargo build --target wasm32-unknown-unknown --release
 *   node ../backend/src/scripts/deployContracts.js
 *
 * Prerequisites:
 *   - stellar CLI installed (npm install -g @stellar/stellar-cli)
 *   - PLATFORM_SECRET_KEY set in backend/.env
 *   - Stellar testnet account funded
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET_KEY;

if (!PLATFORM_SECRET) {
  console.error('PLATFORM_SECRET_KEY is required in backend/.env');
  process.exit(1);
}

const SOROBAN_DIR = path.join(__dirname, '../../../contracts/soroban');
const TARGET_DIR = path.join(SOROBAN_DIR, 'target/wasm32-unknown-unknown/release');

const CONTRACTS = [
  { name: 'escrow', wasm: 'escrow.wasm' },
  { name: 'milestones', wasm: 'milestones.wasm' },
];

function run(cmd) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', cwd: SOROBAN_DIR }).trim();
}

async function deploy() {
  for (const contract of CONTRACTS) {
    const wasmPath = path.join(TARGET_DIR, contract.wasm);
    if (!fs.existsSync(wasmPath)) {
      console.error(`WASM not found: ${wasmPath}`);
      console.error('Run: cd contracts/soroban && cargo build --target wasm32-unknown-unknown --release');
      process.exit(1);
    }

    console.log(`\nDeploying ${contract.name}...`);
    const result = run(
      `stellar contract deploy ` +
      `--wasm ${wasmPath} ` +
      `--source ${PLATFORM_SECRET} ` +
      `--network ${NETWORK}`
    );
    console.log(`${contract.name} contract ID: ${result}`);
  }
}

deploy().catch((err) => {
  console.error('Deployment failed:', err.message);
  process.exit(1);
});
