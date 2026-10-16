/**
 * deployContracts.js
 *
 * Deploys the Soroban escrow and milestones contracts, then records what was
 * deployed in contracts/soroban/deployments/<network>.json so a published
 * contract ID can be traced back to the WASM bytes and transaction that
 * produced it.
 *
 * Usage:
 *   cd contracts/soroban
 *   stellar contract build
 *   node ../backend/src/scripts/deployContracts.js
 *
 * Prerequisites:
 *   - stellar CLI installed (https://github.com/stellar/stellar-cli)
 *   - PLATFORM_SECRET_KEY set in backend/.env
 *   - a funded account on the target network
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET_KEY;

if (!PLATFORM_SECRET) {
  console.error('PLATFORM_SECRET_KEY is required in backend/.env');
  process.exit(1);
}

const SOROBAN_DIR = path.join(__dirname, '../../../contracts/soroban');
const DEPLOYMENTS_FILE = path.join(SOROBAN_DIR, 'deployments', `${NETWORK}.json`);

// `stellar contract build` emits the network-ready wasm under wasm32v1-none. A
// plain cargo build leaves a wasm under wasm32-unknown-unknown that the network
// rejects until it has been optimized, so the optimized sibling is preferred.
const TARGET_DIRS = [
  path.join(SOROBAN_DIR, 'target/wasm32v1-none/release'),
  path.join(SOROBAN_DIR, 'target/wasm32-unknown-unknown/release'),
];

const CONTRACTS = [
  { name: 'escrow', wasm: 'escrow.wasm' },
  { name: 'milestones', wasm: 'milestones.wasm' },
];

function run(cmd) {
  console.log(`> ${cmd}`);
  // The contract ID is printed on stdout and the transaction link on stderr;
  // the deployment record needs both.
  return execSync(`${cmd} 2>&1`, { encoding: 'utf8', cwd: SOROBAN_DIR });
}

function findWasm(fileName) {
  const optimizedName = fileName.replace(/\.wasm$/, '.optimized.wasm');
  for (const dir of TARGET_DIRS) {
    const optimized = path.join(dir, optimizedName);
    if (fs.existsSync(optimized)) return optimized;
    const plain = path.join(dir, fileName);
    if (fs.existsSync(plain)) return plain;
  }
  return null;
}

function contractIdFrom(output) {
  const bare = output.match(/^C[A-Z0-9]{55}$/m);
  if (bare) return bare[0];
  const linked = output.match(/\/contract\/(C[A-Z0-9]{55})/);
  if (linked) return linked[1];
  throw new Error(`Could not read a contract ID from the deploy output:\n${output}`);
}

function txHashFrom(output) {
  const match = output.match(/\/tx\/([0-9a-f]{64})/);
  return match ? match[1] : null;
}

function record(entry) {
  let doc = { network: NETWORK, contracts: [] };
  if (fs.existsSync(DEPLOYMENTS_FILE)) {
    doc = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf8'));
  }
  doc.contracts = (doc.contracts || []).filter(c => c.name !== entry.name);
  doc.contracts.push(entry);
  fs.mkdirSync(path.dirname(DEPLOYMENTS_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

function deploy() {
  const deployed = [];

  for (const contract of CONTRACTS) {
    const wasmPath = findWasm(contract.wasm);
    if (!wasmPath) {
      console.error(`No wasm found for ${contract.name}. Looked for:`);
      for (const dir of TARGET_DIRS) {
        console.error(`  ${path.join(dir, contract.wasm)}`);
        console.error(`  ${path.join(dir, contract.wasm.replace(/\.wasm$/, '.optimized.wasm'))}`);
      }
      console.error('Build first: cd contracts/soroban && stellar contract build');
      process.exit(1);
    }

    console.log(`\nDeploying ${contract.name} from ${path.relative(SOROBAN_DIR, wasmPath)}`);
    const output = run(
      `stellar contract deploy --wasm "${wasmPath}" --source "${PLATFORM_SECRET}" --network ${NETWORK}`
    );

    const entry = {
      name: contract.name,
      network: NETWORK,
      contract_id: contractIdFrom(output),
      deploy_tx: txHashFrom(output),
      wasm: path.basename(wasmPath),
      wasm_sha256: crypto.createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex'),
      deployed_at: new Date().toISOString(),
    };

    record(entry);
    deployed.push(entry);
    console.log(`${entry.name} contract ID: ${entry.contract_id}`);
  }

  console.log(`\nRecorded deployment in ${path.relative(process.cwd(), DEPLOYMENTS_FILE)}`);
  console.log('\nBackend environment:');
  for (const entry of deployed) {
    console.log(`  ${entry.name.toUpperCase()}_CONTRACT_ID=${entry.contract_id}`);
  }
  console.log('\nREADME table:');
  for (const entry of deployed) {
    const url = `https://stellar.expert/explorer/${NETWORK}/contract/${entry.contract_id}`;
    console.log(`  | \`${entry.name}\` | [\`${entry.contract_id}\`](${url}) |`);
  }
}

deploy();
