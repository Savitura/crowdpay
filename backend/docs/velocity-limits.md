# Velocity limits for withdrawal and refund attempts (#1126)

## What it does

Withdrawals and refunds move money and are difficult to reverse. CrowdPay now
applies a per-actor **rolling-window velocity limit** before it creates a new
withdrawal request or refund request:

| Action | Endpoint | Counted rows | Default limit |
| --- | --- | --- | --- |
| Withdrawal attempt | `POST /api/withdrawals/request` | `withdrawal_requests.requested_by` | 5 per hour |
| Refund attempt | `POST /api/refund-requests` | `refund_requests.contributor_id` | 10 per hour |

The count covers every request the actor created in the window, regardless of
the request's later status. Rejected, cancelled, denied, and failed requests
therefore still count as attempts. This is deliberate: an attacker cannot reset
the budget by forcing a request through a failure path.

The counter is derived from the existing request tables, so:

* no schema migration is needed;
* the limit survives application restarts; and
* every backend instance sees the same state without Redis.

## Configuration

All variables are optional. Invalid or negative values fall back to the secure
defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `WITHDRAWAL_VELOCITY_MAX_REQUESTS` | `5` | Withdrawal attempts allowed per actor per window. `0` disables the check. |
| `WITHDRAWAL_VELOCITY_WINDOW_SECONDS` | `3600` | Rolling window length in seconds. |
| `REFUND_VELOCITY_MAX_REQUESTS` | `10` | Refund attempts allowed per actor per window. `0` disables the check. |
| `REFUND_VELOCITY_WINDOW_SECONDS` | `3600` | Rolling window length in seconds. |

Limits are read from the environment on each check, so a restart is enough to
apply a change. Keep values in this range as a starting point:

* Withdrawals: `3`–`10` per hour.
* Refunds: `5`–`20` per hour.

Lower values reduce abuse at the cost of blocking legitimate high-volume
creators and contributors. Monitor the `Velocity limit exceeded` warning logs
during rollout and adjust per environment.

## Response

When the limit is reached the endpoint returns HTTP `429` with a `Retry-After`
header and a machine-readable body:

```json
{
  "error": "Too Many Requests",
  "code": "VELOCITY_LIMIT_EXCEEDED",
  "message": "Withdrawal velocity limit exceeded. Please try again later.",
  "retry_after": 3600,
  "limit": 5,
  "window_seconds": 3600
}
```

`retry_after` and `Retry-After` are conservative: the caller may retry after the
full window. A precise "time until the oldest attempt leaves the window" value
would require an additional indexed query; the conservative value is simpler
and safe. Clients should honour `Retry-After` rather than retry immediately.

## Compatibility

* No request or response schema changes for successful requests.
* No database migration; the query uses the existing
  `refund_requests_contributor_idx` index and the withdrawal request index on
  `requested_by`.
* Existing tests and clients continue to work. A new `429` is the only
  behavioural addition, and it applies only to actors who exceed the
  configured budget.
* The limit can be disabled per action by setting the max to `0`, which is
  useful for local demos and load tests.

## Security and operational notes

* **Threat model.** The limit slows down compromised creator/contributor
  accounts, scripted withdrawal spam, and refund-request floods. It is not a
  substitute for multisig approval, campaign-status checks, refund-window
  checks, or per-contribution balance reservation.
* **Fail behaviour.** If the count query fails (database outage), the request
  fails with the normal server error instead of silently skipping the limit.
  The endpoint already requires the database, so failing closed here does not
  remove availability that existed before.
* **Concurrency.** The check is read-then-insert, so two requests racing in the
  same instant can both pass. The existing one-pending-withdrawal-per-campaign
  rule and the unique active-refund-per-contribution index bound the resulting
  duplication. A future enhancement could take a per-actor advisory lock for
  strict serialisation.
* **Observability.** Blocks emit a structured `Velocity limit exceeded`
  warning with `kind`, `actor_id`, `path`, `count`, `max_requests`, and
  `window_seconds`. Alert on a sustained rate of these warnings; it can
  indicate either a compromised account or limits that are too low.
* **Rollout.** Enable with defaults first, watch the warning rate for a week,
  then tune. Keep the variables in the deployment secret/config map so they
  can be adjusted without a code change.

## Privacy

The limiter reads only the actor's internal user ID and request timestamps.
Those values already live in the withdrawal/refund tables and are not copied to
a new store. The warning log includes the internal user ID (not email, wallet
address, or request reason) so operators can investigate without widening the
set of systems holding personal data. Follow the normal log-retention policy.

## Accessibility

The limit is enforced server-side on JSON APIs. API consumers should surface
the `429` message and respect `Retry-After`; no visual or interaction pattern
is required by this change.
