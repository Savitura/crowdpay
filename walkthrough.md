# feat(refunds): implement refund eligibility and on-chain refund workflow (#757)

## PR Description

### What
Implements an end-to-end refund eligibility and on-chain refund workflow allowing campaign creators and admins to issue partial or full escrow refunds to contributors, with automatic campaign balance adjustment and double-refund guards.

### Why
Closes #757

Campaigns can fail, reach cancelation conditions, or creators may need to issue goodwill refunds. Currently, there is no structured refund mechanism in the platform — creators cannot return escrowed funds directly to specific contributors through the UI, and campaign escrow accounting is not kept in sync.

### How

#### Database (`backend/db/migrations/`)
- `20260924_refund_workflow_enhancements.sql`: Adds `admin_note`, `is_force_refund`, `failure_reason`, and `tx_hash` to `creator_refunds`. Adds `refunded_amount` and `refund_status` tracking to `contributions`, along with indexes for performance.

#### Backend Service (`backend/src/services/refundService.js`)
- `getEligibleContributions(campaignId)`: Identifies refundable contributions with calculated remaining balances, original contribution details, and contributor profile/wallet information.
- `getCampaignRefunds(campaignId, options)`: Returns paginated refund history for the campaign.
- `processRefund(...)`:
  - Enforces database row-level locking (`FOR UPDATE`) to prevent race conditions and double-refunds.
  - Validates amount > 0 and <= remaining contribution balance.
  - Submits on-chain escrow return transaction to contributor's wallet.
  - In case of on-chain failure, records failure reason and rolls back contribution/campaign balances.
  - Decreases campaign `raised_amount` and updates contribution `refunded_amount` and `refund_status`.
  - Dispatches audit logs via `logAuditEvent`, contributor in-app notification via `createNotification`, and email notice via `sendEmail`.
  - Supports admin force-refund with internal audit notes.

#### Backend Routes
- `backend/src/routes/creatorRefunds.js`: Added `GET /eligible` and support for admin force-refunds.
- `backend/src/routes/campaigns.js`: Mounted `GET /:id/refunds/eligible`, `GET /:id/refunds`, and `POST /:id/refunds` for creators and admins.
- `backend/src/index.js`: Mounted `/api/refunds` route.

#### Frontend
- `frontend/src/services/api.js`: Added `getEligibleRefunds`, `getCampaignRefunds`, and `processRefund`.
- `frontend/src/components/RefundsSection.jsx`: UI listing eligible contributions, refund history, modal with explicit amount and reason, admin force-refund checkbox and note, and double-click confirmation guard.
- `frontend/src/pages/Campaign.jsx`: Mounted `RefundsSection` for campaign creators and platform admins.

### Testing
- `backend/src/routes/refunds.test.js`: 7 automated acceptance tests verifying partial refunds, full refunds, double-refund and over-refund rejection, on-chain failure rollback, admin force-refund, and non-existent contributions.
- `backend/src/routes/creatorRefunds.test.js`: 3 tests verifying admin routes and status updates.
- `frontend/src/components/RefundsSection.test.jsx`: 3 component tests verifying rendering, modal workflows, and admin controls.

## Files Changed

| File | Description |
| --- | --- |
| `backend/db/migrations/20260924_refund_workflow_enhancements.sql` | Migration adding refund metadata to `creator_refunds` and `contributions` |
| `backend/src/services/refundService.js` | Core refund service handling on-chain interaction, balance updates, and notifications |
| `backend/src/routes/creatorRefunds.js` | Admin/creator refund endpoints with `/eligible` |
| `backend/src/routes/campaigns.js` | Campaign-level refund sub-routes |
| `backend/src/index.js` | Mounted `/api/refunds` router |
| `backend/src/routes/refunds.test.js` | Acceptance tests for refund service |
| `backend/src/routes/creatorRefunds.test.js` | Tests for creator refund endpoints |
| `frontend/src/services/api.js` | API client methods for refund endpoints |
| `frontend/src/components/RefundsSection.jsx` | Creator/admin refund management UI component |
| `frontend/src/components/RefundsSection.test.jsx` | Frontend test suite for RefundsSection |
| `frontend/src/pages/Campaign.jsx` | Integration of RefundsSection into campaign view |
| `walkthrough.md` | PR walkthrough and test documentation |

## CI Results
- Backend unit tests (`refunds.test.js` + `creatorRefunds.test.js`): Pass (10/10 passed)
- Backend linting: Pass (0 errors)
- Frontend linting: Pass (0 errors)
