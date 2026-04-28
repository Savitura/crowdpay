# CrowdPay

**Global funding infrastructure built on Stellar.**

CrowdPay is not a crowdfunding website — it is a payments protocol with a product layer on top. Contributors anywhere in the world can fund campaigns in any currency. Stellar handles the conversion, settlement, and custody automatically.

---

## Why Stellar

Most crowdfunding platforms are limited by payment rails. Bank transfers are slow, cross-border fees are high, and currency conversion is opaque. CrowdPay eliminates all three by settling everything on Stellar.

| Problem | How Stellar solves it |
|---|---|
| Cross-border payments | Path payments auto-convert any asset to the campaign's target currency |
| Escrow / trust | Multi-signature accounts require both creator and platform to approve withdrawals |
| Fiat on/off ramp | Stellar anchors bridge NGN, USD, EUR to on-chain assets |
| Fees | Stellar transactions cost fractions of a cent |
| Speed | Transactions finalize in 3–5 seconds |

---

## How It Works

### Campaign wallets

Every campaign gets its own Stellar account — not a database row, an actual on-chain account. That account is controlled by two signers:

```
Campaign Account
  Signers:
    Creator key  (weight 1)
    Platform key (weight 1)
  Threshold:
    Medium: 2   ← both must sign to move funds
```

This means funds are locked in escrow by default. No code, no smart contract, no trust — just cryptographic multisig enforced by the Stellar network.

### Contribution flow

```
User clicks "Contribute"
  → Backend builds Stellar transaction
      (Payment or Path Payment depending on asset)
  → User signs (custodial: backend signs; non-custodial: user's wallet)
  → Transaction submitted to Stellar testnet / mainnet
  → Horizon streams ledger events
  → Backend confirms + indexes in PostgreSQL
  → Campaign progress updates in real time
```

### Path payments (the edge)

A contributor in Nigeria with XLM can fund a USD-denominated campaign. Stellar's DEX finds the best conversion path automatically. The campaign receives USDC. The contributor never thinks about exchange rates.

```
XLM (contributor) → [Stellar DEX] → USDC (campaign wallet)
```

---

## Project Structure

```
crowdpay/
├── README.md
├── backend/              # Node.js API — campaign logic, wallet management, Horizon listener
│   ├── src/
│   │   ├── config/       # Stellar + database configuration
│   │   ├── routes/       # REST API routes
│   │   ├── services/     # Stellar SDK interactions, ledger monitoring
│   │   └── middleware/   # Auth
│   ├── API.md            # Contribution/path-payment API reference
│   └── db/
│       └── schema.sql    # PostgreSQL schema
├── frontend/             # React (Vite) — campaign UI
│   └── src/
│       ├── pages/
│       ├── components/
│       └── services/     # API client
└── contracts/            # Stellar transaction templates
    └── stellar/
        ├── campaignWallet.js   # Multisig account creation
        ├── trustlines.js       # Asset trustline management
        ├── pathPayment.js      # Cross-currency contribution
        └── multiSig.js         # Threshold signing helpers
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | Stellar (testnet for development, mainnet for production) |
| Backend | Node.js, Express |
| Database | PostgreSQL |
| Frontend | React, Vite |
| Stellar SDK | `@stellar/stellar-sdk` |
| Auth | JWT |

---

## MVP Scope

- Create campaigns with a target amount and asset (USDC or XLM)
- Auto-generate a multisig campaign wallet on Stellar
- Accept contributions in any Stellar asset (path payment handles conversion)
- Display real-time funding progress (Horizon event stream)
- Withdraw funds (requires both creator + platform signature)

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A Stellar testnet account (free via [Stellar Laboratory](https://laboratory.stellar.org))

### 1. Clone and install

```bash
git clone <repo>
cd crowdpay

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cd backend
cp .env.example .env
# Edit .env — add your Stellar platform keypair and DB credentials
```

Creator identity verification is enforced by default before campaign launch. For local testnet development, set `KYC_REQUIRED_FOR_CAMPAIGNS=false` in the backend environment; optionally mirror it with `VITE_KYC_REQUIRED_FOR_CAMPAIGNS=false` so the frontend knows before the profile request returns. For Persona-hosted verification, configure `KYC_PROVIDER=persona`, `PERSONA_API_KEY`, `PERSONA_TEMPLATE_ID`, and `APP_BASE_URL`.

### 3. Set up the database

```bash
psql -U postgres -c "CREATE DATABASE crowdpay;"
psql -U postgres -d crowdpay -f db/schema.sql
# For existing deployments, apply migration files in backend/db/migrations in order.
```

### 4. Fund your platform account on testnet

```bash
# Run the account setup script
node contracts/stellar/campaignWallet.js --setup-platform
```

This creates and funds a testnet platform account using Friendbot.

### 5. Run

```bash
# Terminal 1 — Backend
cd backend && npm run dev

# Terminal 2 — Frontend
cd frontend && npm run dev
```

Backend runs on `http://localhost:3001`  
Frontend runs on `http://localhost:5173`

---

## Core Stellar Concepts Used

### Multisig escrow
Every campaign wallet is created with `setOptions` to add two signers (creator + platform) and set medium threshold to 2. Funds cannot be withdrawn without both parties signing.

### Trustlines
Before a campaign wallet can receive USDC, it must establish a trustline to the USDC issuer. The backend automates this during campaign creation — users never see it.

### Path payments
Contributions use `pathPaymentStrictReceive` so the campaign always receives the exact asset it expects, regardless of what the contributor sends.

### Horizon streaming
The backend opens a streaming connection to Horizon to watch each campaign wallet for incoming payments. When a payment lands, it is indexed in PostgreSQL and the campaign total updates.

---

## Custody Model

**MVP: Custodial**

The platform holds all private keys in encrypted storage. This gives the best UX — contributors do not need wallets. Users sign in with email. The platform cosigns all transactions.

**Phase 2: Non-custodial**

Integrate Freighter (browser wallet) or WalletConnect. Users hold their own keys. Platform key is still required for campaign withdrawals (enforces milestone gates).

---

## Phase 2 Roadmap

- [ ] Milestone-based fund releases (release tranches, not full balance)
- [ ] Fiat on-ramp via Stellar anchors (NGN, USD)
- [ ] Multi-currency campaigns
- [ ] Freighter wallet integration
- [ ] Public API for third-party campaign embeds

---

## Network

| Environment | Stellar network | Horizon URL |
|---|---|---|
| Development | Testnet | `https://horizon-testnet.stellar.org` |
| Production | Mainnet | `https://horizon.stellar.org` |

Switch via `STELLAR_NETWORK=testnet\|mainnet` in `.env`.
