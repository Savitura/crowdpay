# Contribution Refund Status Tracking & Estimated Completion Times

## Overview

CrowdPay supports multiple refund pathways:

1. **Automated Failed-Campaign Refunds**: Executed on-chain via Soroban escrow contracts (`escrow_contract_id`) or queued via multi-signature Stellar withdrawal transactions when a campaign fails to hit its funding goal by the deadline.
2. **Contributor Self-Service Refund Requests**: Submitted by contributors within the allowed request window (`REFUND_REQUEST_WINDOW_DAYS`), reviewed by creators/administrators, and settled on-chain.
3. **Creator/Administrator Force-Refunds**: Initiated by creators or escalated to administrators for disputed campaigns or goodwill cancellations.

Issue #1108 introduces comprehensive refund status tracking and estimated completion times across the backend and contributor dashboard.

## Unified Refund Statuses & Lifecycle Stages

Contributions transition through standardized stages:

| Status          | Stage                   | Description                                                                              | Estimated SLA              |
| :-------------- | :---------------------- | :--------------------------------------------------------------------------------------- | :------------------------- |
| `not_requested` | `none`                  | Active or funded campaign; no refund requested or needed.                                | `null`                     |
| `eligible`      | `eligible`              | Campaign failed; unrefunded contribution eligible for claim or automatic platform queue. | `Within 24–48 hours`       |
| `pending`       | `review`                | Self-service refund request submitted; awaiting creator or platform review.              | `2–3 business days` (~72h) |
| `approved`      | `settlement`            | Refund request approved; queued for blockchain settlement payout.                        | `Within 24 hours`          |
| `processing`    | `blockchain_processing` | Settlement claimed or contract invocation broadcast to Stellar network.                  | `~5–15 minutes`            |
| `completed`     | `settled`               | Transaction confirmed on Stellar ledger; funds returned to contributor wallet.           | `Completed` (0s)           |
| `rejected`      | `rejected`              | Request reviewed and rejected with reason provided.                                      | `null`                     |
| `failed`        | `failed`                | On-chain settlement transaction encountered a blockchain failure.                        | `Failed — action required` |
| `expired`       | `expired`               | Request window closed without settlement.                                                | `null`                     |

## SLA Calculation Logic

Estimated completion times are determined dynamically based on the current lifecycle stage:

- **Blockchain Processing Stage**: Calculated as `claimed_at + 15 minutes`. If processing exceeds the window, duration floors at `0` seconds with `~5–15 minutes` guidance.
- **Settlement Stage**: Calculated as `reviewed_at + 24 hours`.
- **Review Stage**: Calculated as `created_at + 72 hours` (3 business days).
- **Eligible Failed Campaign**: Calculated as `deadline + 48 hours`.

Remaining seconds until estimated completion are computed as:
$$\text{remaining\_seconds} = \max\left(0, \left\lfloor\frac{T_{\text{target}} - T_{\text{now}}}{1000}\right\rfloor\right)$$

## API Endpoints

### 1. `GET /api/contributions/:id/refund-status`

- **Authentication**: Required (`requireAuth`).
- **Authorization**:
  - The contributor who holds the sender wallet key.
  - The creator of the associated campaign (or team manager).
  - Platform administrators (`role === 'admin'`).
- **Response**: Full tracking object with `refund_status`, `stage`, `stage_label`, `stage_description`, `estimated_completion_at`, `estimated_duration_seconds`, `estimated_time_text`, `tx_hash`, `stellar_tx_url`, and historical `events`.

### 2. `POST /api/contributions/:id/refund`

- **Authentication**: Required (`requireAuth`).
- **Behavior**:
  - Validates campaign status is `failed` (returns `400` otherwise).
  - Checks duplicate refunds (returns `409` if already refunded).
  - Invokes `sorobanService.triggerRefund` on the deployed escrow contract.
  - Updates `contributions.contract_refunded_at`, `contract_refund_tx_hash`, and sets `refunded = true`, `refund_status = 'full'`.
  - Returns `200` with the confirmed transaction hash.

## Contributor Dashboard Integration

In `ContributorDashboard.jsx`:

- **Failed Campaign Summary**: Displays aggregated pending refund totals alongside estimated completion times (`Est. completion: Within 24–48 hours`).
- **Contribution Details**: Each contribution item renders a dedicated refund badge (`Refund pending` / `Refunded`) and its estimated completion timeframe.
- **Accessibility**: Includes `role="status"` and `aria-label` tags so screen readers announce refund status and time updates cleanly without disruptive alerts.

## Operational & Security Impacts

- **Privacy**: Only authorized actors (contributor, creator, admin) can inspect refund tracking details.
- **Auditability**: All state transitions record actor IDs, timestamps, and reason strings in `refund_request_events` and `withdrawal_approval_events`.
- **Idempotency & Reentrancy**: Double-refunds are blocked by atomic database checks (`contract_refunded_at IS NULL` and `refunded = FALSE`).
