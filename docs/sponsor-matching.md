# Sponsor-funded contribution matching campaigns

Sponsor matching lets a backer (the *sponsor*) promise a pool of funds that is
released automatically, contribution by contribution, as other people back a
campaign. A sponsor who pledges `1000` at a `1:1` ratio adds one unit for every
unit a backer gives until the pool is used up. Ratios above `1` amplify the
backer's contribution: `2:1` adds two units per unit given.

The sponsor's money is real campaign funding. Matched amounts are credited to
`campaigns.raised_amount` in the same database transaction that indexes the
contribution, so campaign totals, funding thresholds and the matching pool never
disagree.

## Lifecycle of a pool

| State | Meaning |
| --- | --- |
| `active` | Accepting contributions. Matching is applied in creation order (oldest pool first). |
| `exhausted` | `matched_amount` reached `pledge_amount`. No further matching; the pool can still be completed. |
| `completed` | Closed by the sponsor or the campaign creator. Any unspent remainder is unclaimed and available to be returned to the sponsor. |

A sponsor may hold at most one `active` pledge per campaign. Once a pool is
`exhausted` or `completed` the sponsor can pledge again.

## Matching rules

* Pools are consumed oldest-first (`created_at ASC`).
* `match_amount = min(contribution_amount * match_ratio, remaining_pool)`.
* All amounts are rounded to 7 decimal places (the campaign asset precision).
* Contributions whose ratio produces a match below the asset precision receive
  no matching rather than a rounded-up amount.
* If a campaign has several pools, a single contribution is matched against the
  oldest pool that still has capacity.
* A contribution is matched **at most once**. The inner claim is guarded by
  `COALESCE(contributions.match_amount, 0) = 0`, so replays and concurrent
  indexer passes are no-ops instead of double spends.

## Concurrency guarantees

Two backers can land at the same instant on a campaign with one pool. Sponsor
matching is designed so the outcome is deterministic:

* The active pool row is read with `SELECT ... FOR UPDATE` inside the
  contribution transaction, serialising concurrent spends of the same pool.
* Two concurrent pledges from the same sponsor cannot both succeed: the partial
  unique index `campaign_matches_active_sponsor_idx`
  (`campaign_id`, `sponsor_user_id` `WHERE status = 'active'`) lets exactly one
  insert win. The loser receives `409 DUPLICATE_MATCHING_PLEDGE`.
* `campaign_matches_matched_within_pledge` guarantees
  `matched_amount <= pledge_amount` even if a future code path forgets the cap.

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/campaigns/:id/matches` | public | Aggregated pool progress. Never returns sponsor identifiers. |
| `POST` | `/api/campaigns/:id/matches` | required | Body: `{ "match_ratio": 1, "pledge_amount": "1000" }`. |
| `PATCH` | `/api/campaigns/:id/matches/:matchId/complete` | required | Sponsor or campaign creator only. |
| `GET` | `/api/user/sponsor-matches` | required | Every pledge held by the caller across all campaigns. |

`/api/sponsor-matching/*` is kept as a deprecated alias for existing clients.

### Status codes

| Code | When |
| --- | --- |
| `201` | Pledge created. |
| `400` | Validation failure (bad UUID, non-positive amount, ratio outside `(0, 100]`). |
| `401` | Missing or invalid credentials on a protected endpoint. |
| `403` | Completing a pledge owned by another sponsor/creator. |
| `404` | Unknown campaign or pledge. |
| `409` | `DUPLICATE_MATCHING_PLEDGE` (already an active pledge) or `CAMPAIGN_NOT_MATCHABLE` (campaign is `completed`/`withdrawn`/`failed`/`refunded`). |
| `429` | Rate limited. |

## Limits and configuration

| Setting | Value | Where |
| --- | --- | --- |
| Minimum pledge | `0` exclusive | `MAX_PLEDGE_AMOUNT` / validator in `backend/src/routes/sponsorMatching.js` |
| Maximum pledge | `< 1e13` | `MAX_PLEDGE_AMOUNT` (the column is `NUMERIC(20, 7)`) |
| Match ratio | `(0, 100]` | `MAX_MATCH_RATIO` |
| Amount precision | 7 decimals | `AMOUNT_PRECISION` in `sponsorMatchingService.js` |
| Active pledges per sponsor/campaign | 1 | partial unique index |

No environment variables are required — the feature ships enabled and is
enforced by the database, so a blue/green or rolling deploy is safe: the
migration is additive and the API still accepts the legacy mount path.

## Operational notes

* **Auditing.** Pledges and closures emit `sponsor_match.created` /
  `sponsor_match.completed` audit events with the campaign, ratio and amounts.
  `auditService` redacts anything matching its sensitive-key patterns.
* **Webhooks.** `sponsor_match.created` and `sponsor_match.completed` are
  delivered to campaign webhook subscribers.
* **Logging.** Log lines carry campaign, contribution and pool identifiers plus
  amounts only — no user emails, wallet secrets or tokens.
* **Failure mode.** Matching is processed after the contribution is indexed and
  is intentionally non-blocking: a matching failure is logged as a warning and
  the contribution still succeeds. The contribution can be reconciled later by
  re-running the indexing path, because the claim is idempotent.
* **Rollback.** The migration only adds an index and a `NOT VALID` check
  constraint. Dropping the unique index restores the previous (racy) behaviour,
  so roll back the application deploy first if you need to disable the feature.

## User-facing flow

`frontend/src/components/SponsorMatchingPanel.jsx` is rendered on the campaign
page and covers the whole flow:

* **loading** — progress request in flight;
* **empty** — no sponsor has pledged yet;
* **success** — segmented matching bar, sponsor badges, per-pool usage and the
  remaining pool;
* **failure** — inline error with a retry action, and validation errors for the
  pledge form;
* **pledge form** — signed-in users on a sponsorable campaign can pledge an
  amount and a ratio; a duplicate pledge is reported with the deterministic
  `409` message;
* **close pledge** — a sponsor can close their own pledge, which is how unspent
  funds become reclaimable.
