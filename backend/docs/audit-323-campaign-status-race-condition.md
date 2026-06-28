# Audit: Issue #323 — Campaign Status Transition Race Condition

**Repository:** Savitura/crowdpay  
**Issue:** #323 — Campaign status transition race condition (two UPDATEs not atomic)  
**Audit date:** 2026-06-26  
**Status:** **Resolved**

---

## 1. Executive summary

Issue #323 reported that campaign status transitions could race under concurrent cron or API calls, causing duplicate lifecycle side effects (emails, webhooks, refund queueing) when multiple workers observed the same `active` campaign and attempted to transition it.

The fix consolidates status transitions into **single atomic SQL statements**, adds a **Postgres advisory lock** around the batch cron path, and retains the existing **idempotency guard** in `campaignStatusActions.js`. All acceptance criteria for the issue are met.

---

## 2. Original problem

### 2.1 Symptom

Two concurrent workers (e.g. overlapping hourly cron ticks, or cron + manual admin endpoint) could both attempt to transition the same campaign from `active` → `failed` or `active` → `funded`. Each successful transition triggered downstream hooks (`onCampaignFailed` / `onCampaignFunded`), resulting in duplicate notifications to creators and backers.

### 2.2 Root cause (before fix)

| Area | Prior behavior | Risk |
|------|----------------|------|
| `refreshCampaignStatus()` | Two sequential UPDATEs: first `failed`, then `funded` | Concurrent callers could overlap; hooks fired per RETURNING row without batch serialization |
| `refreshActiveCampaignStatuses()` | Two batch UPDATEs with no cross-process lock | Multiple app instances or overlapping cron ticks could run batch refresh in parallel |
| Hook layer | Idempotency via `campaign_status_events` unique constraint | Mitigated duplicates after the fact, but did not prevent the race at the transition layer |

### 2.3 Example failure scenario

1. Cron job A reads campaign as `active`, deadline passed → prepares to set `failed`
2. Cron job B reads same campaign as `active` → also prepares to set `failed`
3. Both transition and both invoke `triggerCampaignStatusActions`
4. Backers receive duplicate failure/refund emails

---

## 3. Remediation implemented

### 3.1 Files changed

| File | Change |
|------|--------|
| `backend/src/services/campaignStatusService.js` | Atomic single-UPDATE transitions; advisory lock on batch refresh |
| `backend/src/services/campaignStatusService.test.js` | Tests for atomic update, lock skip path, funded-over-failed precedence |

### 3.2 Atomic status transition (single UPDATE)

Both `refreshCampaignStatus()` and `refreshActiveCampaignStatuses()` now use one conditional UPDATE:

```sql
UPDATE campaigns
SET status = CASE
  WHEN raised_amount >= target_amount THEN 'funded'
  WHEN deadline IS NOT NULL
    AND deadline < CURRENT_DATE
    AND raised_amount < target_amount THEN 'failed'
  ELSE status
END
WHERE status = 'active'
  AND (
    raised_amount >= target_amount
    OR (
      deadline IS NOT NULL
      AND deadline < CURRENT_DATE
      AND raised_amount < target_amount
    )
  )
RETURNING id, title, target_amount, raised_amount, deadline, status, escrow_contract_id
```

**Properties:**

- Check and update occur in **one database statement** — no read-then-write gap
- `WHERE status = 'active'` ensures only one worker can transition a given row; subsequent callers get zero RETURNING rows
- `funded` is evaluated before `failed` in the CASE, so a campaign that met its goal is never marked failed even if the deadline also passed
- Hooks run **only** when a row is returned from RETURNING

### 3.3 Distributed lock for batch cron

`refreshActiveCampaignStatuses()` acquires a session-level Postgres advisory lock before processing:

- Lock key: `323001` (`CAMPAIGN_STATUS_REFRESH_LOCK_KEY`, tied to issue #323)
- Mechanism: `pg_try_advisory_lock` (non-blocking) on a dedicated pool connection
- If lock is not acquired: returns `{ funded: [], failed: [], skipped: true }` and logs an info message
- Lock is released in `finally` via `pg_advisory_unlock` before the connection is returned to the pool

**Call sites protected:**

- Hourly in-process cron (`backend/src/index.js` → `startCampaignStatusCron`)
- Admin endpoint `POST /api/campaigns/cron/fail-expired` (`backend/src/routes/campaigns.js`)

### 3.4 Existing idempotency layer (unchanged, defense in depth)

`triggerCampaignStatusActions()` in `campaignStatusActions.js` inserts into `campaign_status_events` with:

```sql
ON CONFLICT (campaign_id, new_status) DO NOTHING RETURNING id
```

If a duplicate hook invocation occurs despite atomic transitions, the second call is a no-op and does not send emails or queue refunds.

---

## 4. Acceptance criteria verification

| Criterion | Result | Evidence |
|-----------|--------|----------|
| Status transitions are atomic — no duplicate transitions possible | **Pass** | Single `UPDATE … WHERE status = 'active'` with RETURNING; Postgres row-level locking on UPDATE |
| `onCampaignFailed` / `onCampaignFunded` hooks fire exactly once per campaign | **Pass** | Hooks invoked only on RETURNING rows; `campaign_status_events` unique constraint prevents duplicate side effects |
| Concurrent cron job runs do not produce duplicate notifications | **Pass** | Advisory lock serializes batch refresh across instances; atomic UPDATE prevents double transition per row |

---

## 5. Test coverage

Unit tests in `campaignStatusService.test.js`:

| Test | Validates |
|------|-----------|
| `refreshActiveCampaignStatuses uses one atomic update and triggers actions` | Single UPDATE per batch run; hooks fire for transitioned rows |
| `refreshActiveCampaignStatuses skips when advisory lock is held` | No UPDATE or hooks when lock unavailable |
| `refreshCampaignStatus uses one atomic update and triggers actions once` | Single UPDATE for single-campaign path |
| `refreshCampaignStatus prefers funded over failed when both conditions apply` | CASE ordering: funded wins |

Related idempotency tests in `campaignStatusActions.test.js` (unchanged):

| Test | Validates |
|------|-----------|
| `triggerCampaignStatusActions sends funded lifecycle notifications once` | Duplicate hook calls do not duplicate emails |
| `recordStatusTransition is idempotent via unique constraint` | Event table deduplication |

**Test run (2026-06-26):** 8/8 tests passed in `campaignStatusService.test.js` and `campaignStatusActions.test.js`.

---

## 6. Architecture after fix

```
┌─────────────────────────────────────────────────────────────────┐
│  Trigger: hourly cron / POST /api/campaigns/cron/fail-expired   │
│           / refreshCampaignStatus(campaignId) after contribution│
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  Batch path only:           │
              │  pg_try_advisory_lock(323001)│
              └──────────────┬──────────────┘
                             │ acquired?
              ┌──────────────┴──────────────┐
              │ no                          │ yes
              ▼                             ▼
        skip (skipped: true)     Atomic UPDATE campaigns
                                 WHERE status = 'active' AND …
                                 RETURNING *
                             │
                             ▼
                    Row returned?
                    ┌──────┴──────┐
                    │ no          │ yes
                    ▼             ▼
               (no hooks)   triggerCampaignStatusActions
                             │
                             ▼
                    INSERT campaign_status_events
                    ON CONFLICT DO NOTHING
                             │
                    ┌────────┴────────┐
                    │ conflict        │ new row
                    ▼                 ▼
               skip side effects   emails, webhooks,
                                   notifications, refunds
```

---

## 7. Intentional non-changes

| Item | Rationale |
|------|-----------|
| `SELECT … FOR UPDATE` not added | Not required when check and update are combined in one atomic UPDATE; row lock is implicit in UPDATE |
| Cron schedule unchanged | Hourly schedule retained; advisory lock handles overlap instead of changing timing |
| `campaignStatusActions.js` unchanged | Existing idempotency guard remains as second line of defense |
| Single-campaign path has no advisory lock | Per-row atomic UPDATE is sufficient; lock targets batch cron parallelism only |

---

## 8. Residual risks and operational notes

| Risk | Severity | Mitigation / note |
|------|----------|-------------------|
| Admin cron call skipped while in-process cron holds lock | Low | Expected; deferred run is safe. Monitor logs for `"Campaign status refresh skipped"` if frequent |
| Advisory lock is session-scoped | Low | Lock acquired and released on same dedicated connection; `finally` block ensures unlock on error |
| `refreshCampaignStatus` called outside batch lock (contributions, v1 API) | Low | Atomic per-row UPDATE prevents duplicate transition; idempotency table catches edge cases |
| Multiple app instances | Addressed | Advisory lock works across all Postgres-connected instances sharing the same database |

---

## 9. Sign-off

| Field | Value |
|-------|-------|
| Issue | #323 |
| Verdict | **Fixed** |
| Primary mechanism | Atomic `UPDATE … RETURNING` |
| Secondary mechanism | Postgres advisory lock (batch cron) |
| Tertiary mechanism | `campaign_status_events` idempotency (pre-existing) |
| Recommended follow-up | None required for issue closure; optional integration test against real Postgres for concurrent cron simulation |
