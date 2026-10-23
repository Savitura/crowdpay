# Authoritative Ledger Reconciliation Runbook

## Overview

CrowdPay uses a hybrid accounting architecture combining PostgreSQL persistence with authoritative Stellar and Soroban on-chain state. The Ledger Reconciliation subsystem ensures that on-chain balances and database records (`campaigns.raised_amount`, `contributions`, `stellar_transactions`) remain strictly synchronized and verifiable.

This runbook serves as the authoritative operational guide for monitoring, diagnosing, executing, and auditing ledger reconciliation across classic multisig accounts and Soroban escrow contracts.

---

## Architecture & Source of Truth

Reconciliation resolves ledger balances using a clear hierarchy of truth:

1. **Soroban Escrow Campaigns (`escrow_contract_id IS NOT NULL`)**:
   - The authoritative balance is retrieved via `getEscrowTotalRaised(campaign.escrow_contract_id)` from the smart contract on-chain.
   - The classic multisig account for contract-mode campaigns remains empty (`0`). Reading the account directly is strictly avoided to prevent booking false negative adjustments or zeroing `raised_amount` (Ref: `#901`).
   
2. **Classic Multisig Campaigns (`escrow_contract_id IS NULL`)**:
   - Authoritative balance is fetched from Horizon via `getCampaignBalance(wallet_public_key)`.
   - **Quarantined Payments Protection**: Quarantined payments (`quarantined_payments` table) reside on-chain in the wallet account but must **never** be credited toward `raised_amount`. Effective live balance is strictly calculated as:
     $$\text{Live Balance} = \max(0, \text{Raw Horizon Balance} - \text{Quarantined Payments Total})$$
     (Ref: `#1092`).

3. **Pending Withdrawals**:
   - Campaigns with an active or pending withdrawal request (`SELECT id FROM withdrawal_requests WHERE campaign_id = $1 AND status = 'pending'`) are skipped during reconciliation cycles to avoid race conditions with outbound settlements.

4. **Closed / Unavailable Accounts**:
   - If an on-chain account or escrow contract is unreachable or closed, the reconciliation engine records the campaign as `skipped` with reason `'wallet_unavailable'` rather than raising a critical error, avoiding permanent false alarms.

---

## Core Components

| Component | File Path | Purpose |
|---|---|---|
| **Reconciliation Service** | `backend/src/services/reconciliation.js` | Core reconciliation engine: calculates diffs, updates `campaigns.raised_amount`, records audit logs, invalidates cache, and notifies Sentry. |
| **Transaction Ledger Service** | `backend/src/services/stellarTransactionService.js` | Inserts system adjustments (`insertContributionAdjustment`, `insertReconciliationAdjustment`) into `stellar_transactions`. |
| **Background Worker Job** | `backend/src/worker.js` | Runs `reconcileCampaignBalances` on a 15-minute cron schedule guarded by the `reconciliation-cron` feature flag. |
| **Contract Treasury Reconciliation**| `backend/src/services/contractTreasury.js` | On-demand verification of milestone withdrawals against contract release events. |
| **Admin & Treasury Endpoints** | `backend/src/routes/treasury.js`<br>`backend/src/routes/admin.js` | Operator and admin routes for on-demand campaign reconciliation inspection. |

---

## Operating Procedures & Workflows

### 1. Scheduled Automated Reconciliation

- **Frequency**: Every 15 minutes via `worker.js`.
- **Feature Flag**: `reconciliation-cron` in `featureFlags.js` (enabled by default).
- **Execution Flow**:
  1. Queries all non-deleted campaigns in `active` or `funded` status.
  2. Bypasses campaigns with pending withdrawals.
  3. Evaluates live balance against database `raised_amount`.
  4. If discrepancy exceeds `DISCREPANCY_EPSILON` (`0.0000001`):
     - Opens atomic database transaction via `withTransaction`.
     - Updates `campaigns.raised_amount` and marks status as `funded` if target reached.
     - Inserts a system contribution adjustment in `contributions`.
     - Inserts a reconciliation adjustment audit in `stellar_transactions` (`kind: 'contribution'`, `status: 'indexed'`, `source: 'reconciliation_adjustment'`).
     - Clears campaign caches (`campaigns:id:<id>`, `campaigns:list:*`, `stats:*`).
     - Emits Sentry warning if discrepancy exceeds `RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD` (default: 1 XLM/USDC).

### 2. Manual Operator Reconciliation

When an operator suspects a balance mismatch or after recovering from dropped Horizon streams:

#### On-Demand Campaign Reconciliation via API
```bash
# Reconcile an individual campaign balance (requires Admin auth token)
curl -X POST "https://api.crowdpay.ng/api/admin/campaigns/{campaign_id}/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

#### Inspecting Treasury Withdrawal Reconciliation
```bash
# Verify contract milestone withdrawals against database records
curl -X GET "https://api.crowdpay.ng/api/campaigns/{campaign_id}/treasury/reconciliation" \
  -H "Authorization: Bearer $CREATOR_OR_ADMIN_TOKEN"
```

### 3. Diagnosing Discrepancies & Alert Response

When Sentry or ops monitoring reports `Campaign raised_amount reconciliation discrepancy`:

1. **Check Sentry Context**:
   - Inspect `diff`, `db_amount`, `on_chain_amount`, and `asset_type`.
2. **Verify Quarantined Payments**:
   ```sql
   SELECT * FROM quarantined_payments WHERE campaign_id = '<campaign_id>';
   ```
   Ensure unrecognized or fraudulent inbound transfers have been properly quarantined.
3. **Verify Pending Transactions & Stream Cursors**:
   ```sql
   SELECT * FROM ledger_stream_cursors WHERE campaign_id = '<campaign_id>';
   SELECT * FROM withdrawal_requests WHERE campaign_id = '<campaign_id>' AND status = 'pending';
   ```
4. **Inspect Ledger Adjustments Trail**:
   ```sql
   SELECT id, kind, status, metadata, created_at
   FROM stellar_transactions
   WHERE campaign_id = '<campaign_id>' AND metadata->>'source' = 'reconciliation_adjustment'
   ORDER BY created_at DESC LIMIT 10;
   ```

---

## Environmental & Configuration Controls

| Variable | Default | Description |
|---|---|---|
| `RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD` | `1` | Discrepancy amount in asset units above which a warning is sent to Sentry. |
| `FEATURE_FLAG_RECONCILIATION_CRON` | `true` | Toggles the 15-minute background reconciliation worker. |
| `HORIZON_URL` / `STELLAR_HORIZON_URL` | — | Horizon RPC endpoint for live account lookups. |
| `SOROBAN_RPC_URL` | — | Soroban RPC endpoint for escrow smart contract calls. |

---

## Operational, Accessibility, Privacy, and Security Impacts

- **Operational Safety**:
  - All balance corrections execute in atomic database transactions (`withTransaction`).
  - Active withdrawal locks (`pending` status) prevent double-spend or race hazards between withdrawal requests and balance updates.
  - Automatic cache invalidation ensures public and donor-facing displays immediately reflect authoritative on-chain state without stale cached figures.
- **Privacy & Redaction**:
  - Audit logs and transaction metadata strip sensitive private keys, encrypted wallet secrets, and signing credentials. Only public ledger hashes and public addresses are recorded.
- **Accessibility**:
  - Discrepancy resolution triggers automated status promotion to `funded` when target is met, guaranteeing campaign milestones and creator payouts unlock smoothly without blocking assistive technologies or requiring manual interface workarounds.
- **Security & Fraud Mitigation**:
  - Quarantined incoming funds are excluded from reconciliation live balances to prevent malicious dust attacks or chargebacks from inflating campaign goals.
