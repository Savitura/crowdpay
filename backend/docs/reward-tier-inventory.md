# Reward-tier inventory & fulfillment (issue #958)

## Overview
Campaign creators can attach a physical inventory limit and fulfillment requirement
to any reward tier. When a contribution matches such a tier:

1. `reserveTierSlot` bumps the tier's backer-slot counter.
2. `reserveInventory` atomically claims physical stock via
   `claim_reward_tier_inventory(reward_tier_id, qty)`.
3. A row is inserted into `reward_tier_inventory_reservations` keyed by
   `(reward_tier_id, contribution_id)` — re-indexing is a no-op.
4. On refund/failure the reservation is moved to `released` and
   `inventory_claimed` is decremented.

## Concurrency
`claim_reward_tier_inventory` takes `SELECT ... FOR UPDATE` on the tier row.
Two concurrent reservations serialize; the loser gets `409 REWARD_TIER_SOLD_OUT`.

## Fulfillment states
`pending → processing → shipped → delivered`
Side branches: `cancelled`, `refunded`. Transitions are enforced in
`updateFulfillmentStatus`; illegal transitions return 409.

## Endpoints
- `GET /api/campaigns/:id/fulfillments` (owner/manager) — list + summary
- `PATCH /api/campaigns/:id/fulfillments/:id` — advance status / tracking
- `GET /api/campaigns/:id/fulfillments/export.csv` — CSV export
- `GET /api/admin/campaigns/:id/fulfillments` — admin view
- `PATCH /api/admin/fulfillments/:id` — admin advance (audited)

## Data isolation
All queries filter by `campaign_id`, which is the campaign-scoped tenant key.
Shipping fields are never logged — only the fulfillment id + status appear
in admin_actions audit rows.
