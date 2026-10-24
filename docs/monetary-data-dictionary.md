# Monetary and Stellar Amount Columns Data Dictionary

This document provides the authoritative data dictionary for all monetary, currency, financial balance, and Stellar amount columns across the CrowdPay platform database schema and application services.

Identified during a repository audit, this reference standardizes column representations, precision guarantees, conversion mechanics, and audit rules across PostgreSQL, Stellar Horizon, Soroban smart contracts, and client APIs.

---

## 1. Architectural Foundation & Stellar Precision Model

### 1.1 The 7-Decimal Stroop Standard

The Stellar network represents all native (XLM) and issued asset (e.g., USDC, Soroban SAC) amounts as signed 64-bit integers (`int64`) denominated in **stroops**:

$$\text{1 unit} = 10^7 \text{ stroops} = 10{,}000{,}000 \text{ stroops}$$

- **One stroop** represents the minimum divisible quantum: `0.0000001` (one ten-millionth of an asset unit).
- **Maximum representable Stellar amount**:
  $$\text{MAX\_STROOPS} = 2^{63} - 1 = 9{,}223{,}372{,}036{,}854{,}775{,}807 \text{ stroops}$$
  $$\approx 922{,}337{,}203{,}685.4775807 \text{ units}$$

### 1.2 Binary Floating-Point Prevention

To prevent catastrophic precision loss and financial drift (e.g. `8.29` drifting to `82,899,999` stroops instead of `82,900,000` under IEEE 754 binary floating-point operations):
1. **Database Storage**: Financial values are stored in PostgreSQL using exact numeric types: primarily `NUMERIC(20, 7)`.
2. **Backend Computation**: Conversion between decimal representations and on-chain stroops occurs strictly via arbitrary-precision string parsing and `BigInt` arithmetic (codified in [`backend/src/utils/stroops.js`](../backend/src/utils/stroops.js)).
3. **Precision Rule**: An amount must be exactly representable in stroops. Fractional inputs beyond the 7th decimal digit are rejected with `INVALID_AMOUNT`, never silently rounded or truncated.
4. **API Serialization**: All financial amounts in JSON HTTP request/response payloads are serialized as canonical decimal strings (e.g., `"10.5000000"` or `"25.00"`), never raw JSON numbers.

---

## 2. Comprehensive Data Dictionary Catalog

### 2.1 Campaigns & Goals

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `campaigns` | `target_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset_type` (XLM/USDC) | No | `CHECK (target_amount > 0)` | Overall funding goal for the campaign in units of `asset_type`. |
| `campaigns` | `raised_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset_type` (XLM/USDC) | No | Default `0`, `CHECK (raised_amount >= 0)` | Total confirmed contributions received towards the campaign goal. |
| `campaigns` | `min_contribution` | `NUMERIC(20, 7)` | 7 | Yes | `asset_type` (XLM/USDC) | Yes | `CHECK (min_contribution > 0)` | Minimum single contribution threshold permitted for this campaign. |
| `campaigns` | `max_contribution` | `NUMERIC(20, 7)` | 7 | Yes | `asset_type` (XLM/USDC) | Yes | `CHECK (max_contribution > 0)` | Maximum single contribution cap permitted per transaction. |
| `campaigns` | `max_per_user` | `NUMERIC(20, 7)` | 7 | Yes | `asset_type` (XLM/USDC) | Yes | `CHECK (max_per_user > 0)` | Cumulative contribution cap across all pledges from a single user. |
| `campaigns` | `velocity_alert_threshold` | `NUMERIC(18, 7)` | 7 | Yes | `asset_type` (XLM/USDC) | Yes | Default `0` | Rate-of-inflow volume threshold triggering velocity anomaly alerts. |
| `campaigns` | `platform_fee_bps` | `INTEGER` | 0 | No | Basis points (bps) | No | Default `0`, `0 <= bps <= 10000` | Platform fee rate in basis points ($1\text{ bps} = 0.01\% = 0.0001$). |
| `campaign_stretch_goals` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Secondary funding milestone unlocking additional stretch objectives. |
| `campaign_budget_categories` | `amount` | `NUMERIC` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Expense allocation breakdown item specified by campaign creator. |
| `campaign_revisions` | `target_amount` | `DECIMAL(18, 7)` | 7 | Yes | Campaign asset | No | Historical snapshot | Snapshot of campaign target amount during draft revision editing. |

### 2.2 Contributions & Path Payments

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `contributions` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | No | `CHECK (amount > 0)` | Net contribution amount credited to the campaign escrow wallet. |
| `contributions` | `source_amount` | `NUMERIC(20, 7)` | 7 | Yes | `source_asset` | Yes | `CHECK (source_amount > 0)` | Source currency amount debited from contributor in path payment swaps. |
| `contributions` | `anchor_amount` | `NUMERIC(20, 7)` | 7 | Yes | `anchor_asset` | Yes | `CHECK (anchor_amount > 0)` | Gross fiat or off-chain deposit amount initiated via SEP-24 anchor. |
| `contributions` | `send_max` | `NUMERIC(20, 7)` | 7 | Yes | `source_asset` | Yes | `CHECK (send_max > 0)` | Maximum source asset expenditure allowed for strict-receive path payments. |
| `contributions` | `platform_fee_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | Yes | Default `0`, `CHECK (>= 0)` | Platform fee withheld from the contribution (rounded half-up in stroops). |
| `contributions` | `refunded_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | Yes | Default `0`, `CHECK (>= 0)` | Cumulative refund amount disbursed back to the original contributor. |
| `contributions` | `refund_reserved_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | Yes | Default `0`, `CHECK (>= 0)` | Amount locked in escrow pending dispute adjudication or refund review. |
| `contributions` | `match_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | Yes | Default `0`, `CHECK (>= 0)` | Sponsor match funds credited alongside contributor pledge. |
| `contributions` | `pool_share_amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | Yes | `CHECK (> 0)` | Contributor's individual share when pledge was executed via a pool. |
| `contributions` | `conversion_rate` | `NUMERIC(30, 15)` | 15 | No | Multiplier ratio | Yes | `CHECK (> 0)` | Quoted path payment exchange rate ($\text{destination} / \text{source}$). |
| `contributions` | `effective_rate` | `NUMERIC(30, 15)` | 15 | No | Multiplier ratio | Yes | `CHECK (> 0)` | Actual realized execution rate after on-chain orderbook matching. |
| `contributions` | `slippage_bps` | `INTEGER` | 0 | No | Basis points | Yes | `0 <= bps <= 10000` | Maximum acceptable slippage tolerance in basis points. |
| `embed_contributions` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | No | `CHECK (amount > 0)` | Contribution amount received through embedded widget interaction. |
| `contribution_gift_notifications` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Contribution amount dedicated as a gift notification. |

### 2.3 Milestones & Fund Releases

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `milestones` | `release_percentage` | `NUMERIC(7, 4)` | 4 | No | Percentage (0–100%) | No | `CHECK (release_percentage > 0 AND <= 100)` | Percentage of raised campaign funds unlocked upon milestone verification. |
| `withdrawal_requests` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Amount requested for withdrawal requiring dual creator + platform signatures. |
| `milestone_auto_release_attempts` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Release amount attempted during automated milestone release execution. |

### 2.4 Subscriptions & Recurring Contributions

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `subscriptions` | `amount_per_period` | `NUMERIC(20, 7)` | 7 | Yes | `asset` | No | `CHECK (amount_per_period > 0)` | Pledged recurring installment amount per billing cycle. |
| `subscription_balances` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Subscription asset | No | `CHECK (amount > 0)` | Amount locked in each on-chain Stellar Claimable Balance installment. |
| `recurring_contributions` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Legacy recurring pledge commitment installment amount. |
| `recurring_payout_schedules` | `amount` | `NUMERIC(18, 7)` | 7 | Yes | Campaign asset | Yes | `CHECK (amount >= 0)` | Fixed creator payout installment amount per scheduled period. |
| `recurring_payout_schedules` | `percentage` | `NUMERIC(5, 2)` | 2 | No | Percentage (0–100%) | Yes | `CHECK (percentage > 0 AND <= 100)` | Percentage of current wallet balance to disburse per scheduled period. |
| `recurring_payout_runs` | `amount` | `NUMERIC(18, 7)` | 7 | Yes | Campaign asset | Yes | `CHECK (amount >= 0)` | Actual executed disbursement amount in an automated creator payout run. |

### 2.5 Contribution Pools & Group Funding

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `contribution_pools` | `target_amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (target_amount > 0)` | Total pooled contribution target required before collective submission. |
| `contribution_pools` | `raised_amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | Default `0`, `CHECK (>= 0)` | Cumulative confirmed member shares pledged to the pool. |
| `pool_members` | `share_amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | Default `0`, `CHECK (share_amount >= 0)` | Individual member's pledged share commitment towards the pool target. |

### 2.6 Sponsor Matching & Referral Programs

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `campaign_matches` | `pledge_amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (pledge_amount > 0)` | Total matching pool committed by the sponsor. |
| `campaign_matches` | `matched_amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | Default `0`, `CHECK (>= 0)` | Cumulative sponsor matching funds disbursed and paired with contributions. |
| `campaign_matches` | `match_ratio` | `NUMERIC(10, 2)` | 2 | No | Multiplier ratio | No | `CHECK (match_ratio > 0)` | Matching multiplier (e.g., `1.00` = 1:1 match, `0.50` = 1:2 match). |
| `referral_rewards` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | `asset_type` | No | `CHECK (amount > 0)` | Earned referral reward commission credited to the referrer. |
| `referral_links` | `commission_paid` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | Default `0`, `CHECK (>= 0)` | Cumulative referral commission paid out via this referral link. |
| `referral_programs` | `commission_percentage` | `NUMERIC(5, 2)` | 2 | No | Percentage (1–20%) | No | `CHECK (commission_percentage BETWEEN 1 AND 20)` | Referrer incentive commission percentage set for the campaign. |

### 2.7 Refunds & Disputed Claims

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `refund_requests` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Contribution asset | No | `CHECK (amount > 0)` | Contributor-requested refund amount pending creator/admin review. |
| `refund_events` | `total_refunded` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (total_refunded >= 0)` | Total amount disbursed to backers in a bulk or campaign failure refund. |
| `creator_refunds` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Campaign asset | No | `CHECK (amount > 0)` | Total refund amount executed in a creator-initiated refund batch. |

### 2.8 Anchor Deposits (SEP-24)

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `anchor_deposits` | `anchor_amount` | `NUMERIC(20, 7)` | 7 | Yes | `anchor_asset` | No | `CHECK (anchor_amount > 0)` | Gross fiat / anchor asset deposit initiated by user. |
| `anchor_deposits` | `contribution_amount` | `NUMERIC(20, 7)` | 7 | Yes | `campaign_asset` | No | `CHECK (contribution_amount > 0)` | Net on-chain contribution credited to campaign after anchor fees/conversion. |

### 2.9 Treasury, Compliance & Governance

| Table | Column | SQL Type | Scale | Stroop Aligned | Paired Asset / Unit | Nullable | Constraints & Bounds | Description |
|---|---|---|---|---|---|---|---|---|
| `wallet_funding_approvals` | `deficit_xlm` | `NUMERIC(20, 7)` | 7 | Yes | XLM | No | `CHECK (deficit_xlm > 0)` | XLM reserve shortfall needing operational approval for account funding. |
| `treasury_policies` | `require_auditor_for_above` | `NUMERIC(20, 7)` | 7 | Yes | Stellar asset | No | Default `0`, `CHECK (>= 0)` | Disbursement threshold above which independent auditor co-signature is mandatory. |
| `quarantined_payments` | `amount` | `NUMERIC(20, 7)` | 7 | Yes | Stellar asset | No | `CHECK (amount > 0)` | Payment amount isolated from campaign ledger due to AML/fraud sanctions. |
| `governance_votes_log` | `token_balance_at_vote` | `NUMERIC(20, 7)` | 7 | Yes | Governance token | No | `CHECK (token_balance_at_vote >= 0)` | Snapshot token balance establishing voter weight at ballot submission. |
| `governance_proposals_meta`| `proposed_fee_bps` | `INTEGER` | 0 | No | Basis points | No | `0 <= bps <= 10000` | Proposed platform fee rate parameter in governance motion. |
| `governance_proposals_meta`| `proposed_creator_share_bps` | `INTEGER` | 0 | No | Basis points | No | `0 <= bps <= 10000` | Proposed creator share parameter in governance motion. |

---

## 3. Operational, Security, Accessibility & Privacy Considerations

### 3.1 Operational Rules
- **Schema Parity**: All newly created monetary or Stellar balance columns must be declared as `NUMERIC(20, 7)` and registered in `backend/src/lib/monetaryDataDictionary.js`. Automated CI tests verify that every `NUMERIC(20, 7)` column in `db/schema.sql` is cataloged.
- **Atomic Operations**: Database balance increments (`raised_amount = raised_amount + $1`) are performed atomically within transaction blocks alongside the corresponding `contributions` insertion to eliminate race conditions.

### 3.2 Security & Financial Invariants
- **Overflow Protection**: Database `NUMERIC(20, 7)` supports up to 13 integer digits (up to $10^{13}$ units), safely encompassing the maximum Stellar supply ($\approx 9.22 \times 10^{11}$ units).
- **No Float Casts**: Values must never pass through `parseFloat()` or JavaScript binary floating-point math before reaching contract invocations or ledger submissions.
- **Fee Split Rounding**: When calculating platform fees, the fee is rounded half-up in stroops, and the net contribution is calculated by exact subtraction (`net = amount - fee`), guaranteeing that $\text{fee} + \text{net} = \text{amount}$ down to the last stroop.

### 3.3 Privacy
- Financial totals (`raised_amount`, `target_amount`) are public.
- Individual contributor donation amounts (`contributions.amount`) respect the campaign's `show_backer_amounts` flag and user privacy preferences (`contributor_privacy_preferences`).
- Quarantined payment records and AML audit amounts are restricted to compliance operators and excluded from public campaign queries.

### 3.4 Accessibility (a11y)
- Frontend UI components format amounts using standard currency / symbol announcements (e.g. `aria-label="100 Stellar Lumens"` or `"50 United States Dollar Coin"`).
- Exact amounts are retained in data attributes (`data-amount-stroops`), while visual representations may format using localized digit groupings (`1,000.00 XLM`).

---

## 4. Migration & Compatibility Notes

- **Existing API & UI Compatibility**: Completely preserved. All database columns, names, and JSON fields remain unchanged.
- **Programmatic Catalog Access**: Backend services and test suites can import `getMonetaryColumn`, `hasMonetaryColumn`, `listMonetaryColumns`, and `validateMonetaryValue` from `backend/src/lib/monetaryDataDictionary.js`.
