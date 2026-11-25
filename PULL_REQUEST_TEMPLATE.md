## Description

Fixes #397 — Reward tier `claimed_count` is now atomically decremented when a tier-backed contribution is made, preventing overselling of limited-edition reward tiers.

**The Problem**
The `claimed_count` (and hence computed `remaining`) on `reward_tiers` was only incremented asynchronously in the ledger monitor when Horizon detected the on-chain payment. The contribution route itself never decremented the count, so:
- Sold-out tiers continued showing availability in the UI
- Multiple backers could claim the last slot of a limited tier
- Creators could end up owing more physical rewards than they could fulfil

**The Fix**
A new `reserveTierSlot()` function in `rewardTierService.js` atomically increments `claimed_count` **inside the contribution route's database transaction** — before the Stellar transaction is even submitted. If the tier is already at capacity, the contribution is rejected with **HTTP 409 Sold out** and the entire transaction is rolled back.

## Changes

### `backend/src/services/rewardTierService.js`
- **`reserveTierSlot(client, { tierId, campaignId })`** — Atomically increments `claimed_count` via `UPDATE ... WHERE (tier_limit IS NULL OR claimed_count < tier_limit) RETURNING`. Returns the tier row on success, or `null` if sold out.
- **`assignTierToContribution(client, { ..., tierId })`** — Extended to accept an optional `tierId`. When provided, only creates the `contribution_rewards` join row (idempotent via `ON CONFLICT DO NOTHING`) without double-incrementing `claimed_count`, since the route already reserved the slot.

### `backend/src/routes/contributions.js`
- Custodial `POST /` route now extracts optional `tier_id` from `req.body`
- Validates the tier belongs to the campaign (pre-flight `SELECT`)
- Calls `reserveTierSlot()` inside the existing transaction, **before** submitting to Stellar
- Returns **HTTP 409** with `{ error: "This reward tier is sold out", tier_id }` if the tier is at capacity
- Passes `tierId` through to `submitCustodialContribution` so it flows into metadata

### `backend/src/services/contributionService.js`
- Accepts new `tierId` parameter and includes it in `stellar_transactions.metadata` as `tier_id`

### `backend/src/services/ledgerMonitor.js`
- Reads `tier_id` from `stellar_transactions.metadata` and passes it to `assignTierToContribution`, ensuring pre-reserved tiers are honoured without double-counting `claimed_count`

### `backend/src/middleware/validation.js`
- Added optional `tier_id` validation (UUID format) to `contributionValidation`

## How It Works End-to-End

```
User contributes (with tier_id)
  │
  ├─ 1. Route validates tier exists & belongs to campaign (pre-flight)
  │
  ├─ 2. BEGIN transaction
  │     ├─ Advisory lock (campaign + user)
  │     ├─ Check per-user cap
  │     ├─ reserveTierSlot() → UPDATE reward_tiers SET claimed_count++ 
  │     │                        WHERE id = tier_id AND claimed_count < tier_limit
  │     │                        RETURNING id
  │     │     └─ If 0 rows → ROLLBACK, respond 409 Sold out 🚫
  │     ├─ Submit Stellar transaction
  │     ├─ Insert stellar_transactions record (metadata.tier_id set)
  │     └─ COMMIT ✅
  │
  └─ 3. (async) Ledger monitor indexes on-chain payment
        ├─ Insert contributions row
        ├─ assignTierToContribution(tierId) → creates contribution_rewards
        │   (idempotent via ON CONFLICT DO NOTHING, no double-increment)
        └─ Update campaign raised_amount
```

## Acceptance Criteria

| Criteria | Status |
|----------|--------|
| Tier `claimed_count` decrements atomically with each contribution | ✅ `UPDATE ... SET claimed_count = claimed_count + 1` inside route transaction |
| Contribution rejected with 409 when tier is sold out | ✅ `reserveTierSlot()` returns null → `res.status(409)` |
| Concurrent contributions for the last slot handled correctly (only one succeeds) | ✅ Atomic `UPDATE ... WHERE claimed_count < tier_limit` with PostgreSQL row-level locking inside transaction |
| Tier sold-out state reflected in UI immediately | ✅ `claimed_count` is updated atomically in the route, so the next `listTiersWithAvailability()` query reflects the correct `remaining` |

## Testing

- [ ] `npm test` passes.
- [ ] If SQL migrations changed, verified they converge cleanly.
- [ ] If Soroban contracts changed, ran contract tests and verified snapshots.
- [ ] If monetary logic changed, used `stroops.js` for exact arithmetic.

- [ ] Unit test `reserveTierSlot()` — success path
- [ ] Unit test `reserveTierSlot()` — sold-out path returns null
- [ ] Unit test `assignTierToContribution()` with explicit `tierId` — no double-increment
- [ ] Integration: contribute with valid `tier_id`, verify `claimed_count` incremented
- [ ] Integration: contribute with sold-out `tier_id`, verify 409 response
- [ ] Integration: concurrent contributions for last slot, verify exactly one 202 and one 409
