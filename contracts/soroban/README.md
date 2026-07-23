# CrowdPay Soroban Contracts

This directory contains the Soroban smart contracts that power the CrowdPay platform's on-chain functionality. The contracts are designed to handle campaign funding, fund escrow, and milestone-based fund releases in a secure and transparent manner.

## Project Structure

```
contracts/soroban/
├── contracts/
│   ├── crowdpay/        # Main campaign contract (legacy/alternative implementation)
│   ├── escrow/          # Escrow contract for fund management and platform fees
│   └── milestones/      # Milestone verification and fund release contract
├── Cargo.lock
├── Cargo.toml
└── README.md
```

## Core Contracts Overview

### 1. `crowdpay` Contract

A self-contained campaign contract that combines funding, escrow, and basic milestone management in a single contract (legacy implementation).

**Primary Entry Points:**

- `initialize`: Set up a new campaign with goal, deadline, creator, token, and milestones
- `contribute`: Allow a contributor to send tokens to the campaign
- `release_milestone`: Release funds to the creator when a milestone is met
- `refund`: Refund contributions if the campaign fails
- `set_failed`: Mark the campaign as failed if the deadline passes and the goal isn't met
- `get_status`: Retrieve the current campaign status
- `get_total_raised`: Get the total amount raised by the campaign

### 2. `escrow` Contract

A specialized contract focused on secure fund management, contributor tracking, and platform fee calculations for individual campaigns.

**Primary Entry Points:**

- `initialize`: Configure the escrow contract for a specific campaign with admin, target, deadline, asset, and platform fee settings
- `deposit`: Accept contributions from backers and lock them in the contract
- `approve_withdrawal`: Approve a withdrawal amount (admin-only)
- `execute_withdrawal`: Transfer approved funds to the recipient, deducting platform fees
- `refund`: Return contributions to backers if the campaign fails
- `get_total_raised`: Check how much the campaign has raised
- `get_asset`: Get the token asset used for the campaign
- `get_platform_fee_config`: Retrieve platform fee configuration
- `propose_fee_change`, `confirm_fee_change`, `cancel_fee_change`, `get_pending_fee`: Manage platform fee updates with a two-step approval process

**Security Features:**

- Maximum platform fee cap of 10% (1000 basis points)
- Two-step fee change process to prevent accidental or malicious fee hikes
- Contributor balance tracking in persistent storage

### 3. `milestones` Contract

Handles milestone creation, submission, and verification, with cross-contract calls to the escrow contract for fund releases.

**Primary Entry Points:**

- `initialize`: Configure milestone contract with creator, platform, escrow address, and milestone definitions
- `submit_milestone`: Campaign creator submits evidence for a milestone completion
- `approve_milestone`: Platform verifies milestone evidence and triggers fund release from escrow
- `reject_milestone`: Platform rejects a milestone submission
- `get_milestone`: Get details for a specific milestone
- `get_all_milestones`: Retrieve all milestones for a campaign

**Milestone Workflow:**

1. Creator submits a milestone with evidence (hash stored on-chain)
2. Platform reviews the evidence
3. If approved, milestones contract calls escrow to approve and execute the withdrawal
4. If rejected, creator can resubmit

## Architecture & Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CrowdPay Platform                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │   Frontend UI    │  │   Backend API    │  │  Ledger       │  │
│  │                  │  │                  │  │  Monitor      │  │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘  │
│           │                     │                     │          │
│           ▼                     ▼                     ▼          │
├─────────────────────────────────────────────────────────────────┤
│                         Stellar Network                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Soroban Contracts                      │  │
│  │  ┌──────────────┐     ┌──────────────┐     ┌──────────┐  │  │
│  │  │  Milestones  │────▶│    Escrow    │     │ CrowdPay │  │  │
│  │  │  Contract    │     │  Contract    │     │ Contract │  │  │
│  │  └──────────────┘     └──────────────┘     └──────────┘  │  │
│  │         │                     │                            │  │
│  │         └─────────────────────┼────────────────────────────┘  │
│  │                               ▼                               │  │
│  │                    ┌──────────────────┐                       │  │
│  │                    │  Stellar Tokens  │                       │  │
│  │                    │  (SAC, USDC, etc)│                       │  │
│  │                    └──────────────────┘                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

### Interaction Flow:

1. **Campaign Creation:**
   - Backend deploys and initializes escrow contract
   - Backend deploys and initializes milestones contract (linked to escrow)
1. **Contribution Phase:**
   - Frontend initiates contribution via backend
   - Backend calls `deposit` on escrow contract
   - Escrow contract locks funds and updates contributor balances
1. **Milestone Phase:**
   - Creator submits milestone evidence via frontend/backend
   - Backend calls `submit_milestone` on milestones contract
   - Platform reviews and approves via `approve_milestone`
   - Milestones contract calls escrow's `approve_withdrawal` and `execute_withdrawal`
   - Funds are released to creator with platform fee deducted
1. **Refund Phase (if campaign fails):**
   - Backend or contributor calls `refund` on escrow contract
   - Escrow verifies deadline passed and target not met
   - Funds returned to individual contributors

## Developer Workflows

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Soroban CLI](https://developers.stellar.org/docs/build/sdks-and-libraries/cli)
- Stellar network configuration (Testnet recommended for development)

### Building the Contracts

To build all contracts:

```bash
cd contracts/soroban
stellar contract build
```

Or build individual contracts:

```bash
cd contracts/soroban/contracts/escrow
stellar contract build

cd ../milestones
stellar contract build
```

### Running Tests

```bash
# All tests
cd contracts/soroban
stellar contract test

# Individual contract tests
cd contracts/soroban/contracts/escrow
cargo test

cd ../milestones
cargo test
```

### Testnet Deployment

First, configure your Soroban CLI for the Testnet:

```bash
# Generate and fund a test account if you don't have one
stellar keys generate --network testnet crowdpay-dev
stellar keys fund --network testnet crowdpay-dev

# Set up network configuration
stellar network add --rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015" testnet
```

Deploy escrow contract:

```bash
cd contracts/soroban/contracts/escrow
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow.wasm \
  --source crowdpay-dev \
  --network testnet
```

Deploy milestones contract:

```bash
cd ../milestones
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/milestones.wasm \
  --source crowdpay-dev \
  --network testnet
```

Initialize escrow contract (example):

```bash
stellar contract invoke \
  --id <ESCROW_CONTRACT_ID> \
  --source crowdpay-dev \
  --network testnet \
  -- \
  initialize \
  --admin <ADMIN_ADDRESS> \
  --campaign_id 12345 \
  --target 1000000000 \
  --deadline 1767225600 \
  --asset <ASSET_CONTRACT_ADDRESS> \
  --platform_fee_bps 500 \
  --platform_fee_recipient <PLATFORM_ADDRESS>
```

## Backend Integration

The CrowdPay backend integrates with Soroban contracts using:

- `sorobanService.js` - Core service for contract interaction
- `@stellar/stellar-sdk` - Stellar JavaScript SDK for transaction building and submission

### Key Integration Points

1. **Contract Invocation**
   - `invokeContract`: Builds, simulates, signs, and submits write transactions
   - `invokeContractReadOnly`: Simulates read-only transactions
1. **Event Listening**
   - The backend ledger monitor processes events emitted by contracts (e.g., `deposit`, `withdrawal`, `refund`, `fee_changed`)
   - Events are used to update the off-chain database and trigger notifications
1. **Contract Deployment**
   - `uploadContractWasm`: Uploads contract WASM to the network
   - `createContractFromWasmHash`: Creates contract instances from uploaded WASM hashes
   - `deployCampaignContracts`: Orchestrates deployment and initialization of escrow and milestones contracts for a campaign
1. **Data Type Conversion**
   - `nativeToScVal`: Converts JavaScript types to Soroban values
   - `scValToNative`: Converts Soroban values back to JavaScript types

### Environment Configuration

The backend uses these environment variables for Soroban integration:

- `SOROBAN_ENABLED`: Set to "true" to enable Soroban features
- `ESCROW_WASM_HASH`: Hash of the deployed escrow contract WASM
- `MILESTONES_WASM_HASH`: Hash of the deployed milestones contract WASM
- `ESCROW_CONTRACT_ID`: Pre-deployed escrow contract ID (optional, skips deployment)
- `MILESTONES_CONTRACT_ID`: Pre-deployed milestones contract ID (optional, skips deployment)
- `PLATFORM_SECRET_KEY`: Secret key of the platform Stellar account
