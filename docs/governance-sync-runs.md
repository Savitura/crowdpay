# Governance sync runs

Governance synchronization copies on-chain proposal state (votes and status
from the fee registry contract's pending proposal) into
`governance_proposals_meta`. Each run is recorded in `governance_sync_runs`, so
operators can see when sync ran, what it changed, and why it failed without
reading logs (#839).

## What a run records

| Column | Meaning |
| --- | --- |
| `trigger` | `scheduled`, `manual` (operator "Sync now"), or `retry` |
| `status` | `running`, then exactly one of `succeeded` / `failed` |
| `started_at`, `finished_at` | Timestamps from the database clock |
| `proposals_seen` | Proposals read from the provider (0 or 1 today: the pending proposal) |
| `proposals_updated` | Proposal rows whose votes/status actually changed |
| `proposals_missing` | Proposals found on chain with no matching database row (not created by sync) |
| `provider_cursor` | Last provider position synced, e.g. `proposal:7` |
| `error_code`, `error_message` | Failure category and a bounded summary with secrets/credentials redacted |
| `retry_of_run_id` | For a retry, the failed run it retries |
| `requested_by` | Operator who triggered a manual run or retry (NULL for scheduled runs, or after that user is deleted) |

Error codes: `PROVIDER_NOT_CONFIGURED` (no `FEE_REGISTRY_CONTRACT_ID`),
`PROVIDER_ERROR` (contract read failed), `DATABASE_ERROR` (proposal update
failed), `ABANDONED` (the process died mid-run), `SYNC_ERROR` (anything else).

A finished row is immutable: a database trigger rejects every update to it,
except setting `requested_by` to NULL when the operator's user row is deleted.

## Relationship to proposal state

A run only **updates** existing `governance_proposals_meta` rows, matched by
`stellar_proposal_id`, and only when the on-chain values differ. It never
inserts or deletes proposals, so repeating a run or retrying one never
duplicates proposal state. The run row is history about the sync; the proposal
row remains the source of truth for the API and UI.

## Concurrency policy

At most one run can be `running` at a time. A unique partial index enforces
this, so the rule holds across processes and instances. A trigger that arrives
while a run is in flight is **deduplicated**: no run is created, and the
caller gets the in-flight run back. `POST /api/governance/sync` returns `409
SYNC_ALREADY_RUNNING` with that run, and a scheduled tick simply skips.

If a process dies mid-run, its row stays `running` until
`RUN_ABANDON_AFTER_MS` (5 minutes) has passed. The next trigger then finalizes
it as `failed` / `ABANDONED` before starting. Until then, new triggers are
deduplicated against it.

## Retry

`POST /api/governance/sync/runs/:id/retry` is allowed only for a `failed` run.
It starts a **new** run with `trigger = 'retry'` and `retry_of_run_id` set, and
never edits the failed run. Each failed run can have at most one retry (a
unique index), so repeating the request returns the existing retry (`200`,
`deduplicated: true`) instead of syncing again. If that retry also fails,
retry the retry.

## Operator API (admin only)

All endpoints require an authenticated admin (`requireAuth` + `requireAdmin`).

- `POST /api/governance/sync`: run now. Returns `200` (succeeded), `502`
  (failed; the run is in the body), or `409` (deduplicated).
- `GET /api/governance/sync/runs?status=&trigger=&limit=&offset=`: newest
  first. `limit` defaults to 20 and is capped at 100. `status` and `trigger`
  must be valid enum values (otherwise `400 INVALID_FILTER`).
- `GET /api/governance/sync/runs/:id`: one run plus the retries pointing at it.
- `POST /api/governance/sync/runs/:id/retry`: see [Retry](#retry).

Manual runs and retries are also written to the admin audit log
(`governance_sync_triggered`, `governance_sync_retried`).

The Governance page shows the same history, filters, detail and retry controls
to admins.

## Scheduling

`startGovernanceSyncScheduler()` in `backend/src/services/governanceSyncRuns.js`
runs a `scheduled` sync every `GOVERNANCE_SYNC_INTERVAL_MS` (default 15
minutes), then applies retention. It is not started automatically. The worker
bootstrap (#798) should call it in exactly one place per deployment, though
the concurrency policy keeps extra schedulers harmless.

## Retention

`purgeExpiredRuns()` deletes finished runs older than
`GOVERNANCE_SYNC_RETENTION_DAYS` (default 180). It deletes leaf runs first and
keeps any run that a still-retained retry points at, so retry links are never
broken. Running runs are never purged.
