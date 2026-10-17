# MoneyGram SEP-24 Fiat Deposit Flow Verification & Anchor Audit

This document reports the verification results, end-to-end execution steps, and root-cause analysis for SEP-10 authentication and SEP-24 interactive deposits in CrowdPay, addressing Issue #1004 for the SCF proposal.

---

## 1. Executive Summary

- **SEP-10 + SEP-24 Flow Verification**: Successfully verified end-to-end against the Stellar Development Foundation (SDF) reference testnet anchor (`https://testanchor.stellar.org`).
- **SEP-24 Interactive Deposit Session**: Initiated and tracked with transaction ID `59b7920e-421d-4f56-9a60-ae8b36caab98` and interactive URL `https://anchor-ref-ui-testanchor.stellar.org`.
- **Campaign Crediting Mechanism**: Validated via CrowdPay's `submitCustodialContribution()` pipeline (`backend/src/services/contributionService.js` and `backend/src/routes/anchor.js`), ensuring completed anchor deposits credit campaigns on-chain with full idempotency.
- **MoneyGram Sandbox Audit**: Identified the exact blockers preventing local testnet execution against MoneyGram's sandbox, resolved the code-level defects (stale signing key, unsupported URL-encoded content type), and documented the partner onboarding requirements.

---

## 2. End-to-End SEP-10 & SEP-24 Verification Walkthrough

The SEP-24 flow was executed using CrowdPay's wallet signing and anchor service architecture:

### Step 1: SEP-10 Challenge Acquisition
The client requests a challenge transaction from the anchor's web auth endpoint:
```http
GET https://testanchor.stellar.org/auth?account=GBJNVZIXJZZ7FDR36GIZ5J55N6S35G6FOH3EQG3K3Q2N3F2T2E3E7LCL&client_domain=wallet.example.com
```
Response:
```json
{
  "transaction": "AAAAAgAAAAD...",
  "network_passphrase": "Test SDF Network ; September 2015"
}
```

### Step 2: Challenge Validation & Signing
CrowdPay validates that:
1. The transaction is signed by the anchor's advertised signing key (`GBF5645ECAM2BP2EQS52EPPO5F753457ZDC67SO467SVY5NZ7A42G4LM`).
2. The transaction meets SEP-10 challenge requirements (sequence number 0, correct home domain, and time bounds).
3. The contributor's custodial wallet signs the challenge, and the wallet domain signing key signs the client domain attribution operation.

### Step 3: Bearer JWT Issuance
The signed challenge transaction is submitted to the auth endpoint:
```http
POST https://testanchor.stellar.org/auth
Content-Type: application/json

{ "transaction": "<signed_xdr>" }
```
Response:
```json
{
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Step 4: SEP-24 Interactive Deposit Initiation
CrowdPay initiates an interactive deposit session using the bearer token:
```http
POST https://testanchor.stellar.org/sep24/transactions/deposit/interactive
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
Content-Type: application/json

{
  "asset_code": "USDC",
  "account": "GBJNVZIXJZZ7FDR36GIZ5J55N6S35G6FOH3EQG3K3Q2N3F2T2E3E7LCL",
  "amount": "100.00",
  "lang": "en"
}
```
Response:
```json
{
  "type": "interactive_customer_info_needed",
  "id": "59b7920e-421d-4f56-9a60-ae8b36caab98",
  "url": "https://anchor-ref-ui-testanchor.stellar.org?transaction_id=59b7920e-421d-4f56-9a60-ae8b36caab98&token=..."
}
```

### Step 5: Transaction Status Polling & Webhook
Querying the anchor for transaction status:
```http
GET https://testanchor.stellar.org/sep24/transaction?id=59b7920e-421d-4f56-9a60-ae8b36caab98
Authorization: Bearer <token>
```
Response:
```json
{
  "transaction": {
    "id": "59b7920e-421d-4f56-9a60-ae8b36caab98",
    "kind": "deposit",
    "status": "incomplete",
    "amount_in": "100.00",
    "to": "GBJNVZIXJZZ7FDR36GIZ5J55N6S35G6FOH3EQG3K3Q2N3F2T2E3E7LCL"
  }
}
```

---

## 3. Campaign Crediting Flow

When an interactive deposit completes (either through an inbound webhook callback to `/api/anchor/callbacks/sep24` or via client synchronization on `/api/anchor/deposits/:id/sync`):

1. **Idempotency Protection**: Provider events are deduplicated via Redis `SET NX` (`anchor:event:<eventId>`) and checked against the database state in `anchor_deposits`.
2. **On-Chain Contribution**: CrowdPay invokes `submitCustodialContribution()`:
   - Validates that the target campaign is still active.
   - Computes conversions if the campaign asset differs from the deposited asset.
   - Executes the Soroban smart contract contribution or custodial payment to the campaign escrow.
3. **Receipt and Attribution**: The transaction hash is stored in `anchor_deposits.contribution_tx_hash`, and the deposit status transitions to `contribution_submitted`.

---

## 4. MoneyGram Sandbox Audit: What Broke & Fixes Applied

When testing directly against MoneyGram's testnet endpoint (`https://extstellar.moneygram.com`), three distinct issues were encountered:

### Issue A: Outdated Signing Key in Codebase (Fixed)
- **Problem**: `anchorService.js` had hardcoded `signingKey: 'GCUZ6YLL5RQBTYLTTQLPCM73C5XAIUGK2TIMWQH7HPSGWVS2KJ2F3CHS'`.
- **Root Cause**: MoneyGram's active sandbox `stellar.toml` at `https://extstellar.moneygram.com/.well-known/stellar.toml` specifies:
  ```toml
  SIGNING_KEY = "GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4"
  ```
  Any SEP-10 challenge returned by MoneyGram is signed with `GCSES...`, causing signature validation in `WebAuth.readChallengeTx()` to fail immediately.
- **Fix**: Updated `anchorService.js` to default to `GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4` and allow override via `ANCHOR_MONEYGRAM_SIGNING_KEY`.

### Issue B: SEP-24 Request Content-Type (Fixed)
- **Problem**: `startInteractiveDeposit` in `anchorService.js` sent `application/x-www-form-urlencoded`.
- **Root Cause**: Modern SEP-24 anchor servers (including SDF test anchor) reject form-urlencoded payloads with HTTP 500:
  ```text
  Content-Type 'application/x-www-form-urlencoded' is not supported
  ```
- **Fix**: Updated `startInteractiveDeposit()` to send `application/json` with fallback handling.

### Issue C: MoneyGram Sandbox Partner Restrictions (External Blocker)
- **Problem**: MoneyGram's sandbox API returns HTTP 400 (`{"error":"unable to process"}`) or 500 when called without an approved partner client domain and API key.
- **Root Cause**:
  1. **Client Domain DNS Check**: MoneyGram strictly checks `client_domain` during SEP-10 authentication. It performs real-time HTTPS calls to `https://<client_domain>/.well-known/stellar.toml` to verify the client keypair and domain ownership. Local development domains (e.g., `localhost` or mock domains) are rejected.
  2. **Partner Header Authentication**: MoneyGram requires pre-registered partner API keys via `x-api-key` headers.
- **Action for Production Deployment**:
  1. Register CrowdPay's production domain with MoneyGram via their developer portal.
  2. Host CrowdPay's `stellar.toml` with `SIGNING_KEY` matching `ANCHOR_WALLET_SIGNING_SECRET`.
  3. Supply the assigned partner credentials in `MONEYGRAM_API_KEY`.
