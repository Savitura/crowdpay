# Contributor communication preferences per campaign (#961)

**Status**: shipped — see [outcome surveys](outcome-surveys.md) for the feature
that consumes the `surveys` channel.

---

## Why

CrowdPay had exactly two notification opt-out layers:

| Layer | Scope | Stored in |
| --- | --- | --- |
| Account category switch | every campaign, forever | `notification_preferences` |
| Follow-row opt-in | one campaign, but only if you *follow* it | `campaign_followers` |

That leaves a real gap. A contributor who backs a dozen campaigns and wants to
mute milestone chatter on **one** noisy campaign has no way to express that:
either they mute milestones everywhere, or they stop following (and lose every
other notification) on that campaign.

This feature adds the missing middle layer.

```
global notification_preferences        account-wide, per category
        ↓  (category still allowed?)
campaign_communication_preferences     per campaign, per channel   ← new
        ↓  (channel still wanted?)
campaign_followers                    per-follower opt-ins
```

---

## Data model

`backend/db/migrations/20261001_campaign_communication_preferences.sql`

```sql
CREATE TABLE campaign_communication_preferences (
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updates         BOOLEAN NOT NULL DEFAULT TRUE,
  milestones      BOOLEAN NOT NULL DEFAULT TRUE,
  funding_updates BOOLEAN NOT NULL DEFAULT TRUE,
  messages        BOOLEAN NOT NULL DEFAULT TRUE,
  surveys         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id)
);
```

### Channels

| Channel | Gates |
| --- | --- |
| `updates` | campaign update posts and their email + in-app notification |
| `milestones` | milestone progress, evidence submissions, reviews, releases |
| `funding_updates` | 25 / 50 / 75 / 100 % funding-threshold announcements |
| `messages` | comment replies and thank-you messages |
| `surveys` | outcome survey invitations (see [outcome surveys](outcome-surveys.md)) |

### Backward compatibility

- **Every channel defaults to `TRUE`**, and an **absent row means "no
  override"**. Shipping this feature therefore changes nobody's existing mail.
- The table is created by a new migration; no existing table is altered, so the
  change is rollback-safe and does not lock a hot table.
- `ON DELETE CASCADE` on both foreign keys means a deleted campaign or deleted
  user takes its rows with it — there is no orphaned-preference class of bug.

---

## API

Mounted at `/api/campaigns` from
`backend/src/routes/campaignCommunicationPreferences.js`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/campaigns/communication-preferences/channels` | none | Channel metadata for rendering labels |
| `GET` | `/api/campaigns/:campaignId/communication-preferences` | user | Effective preferences for this campaign |
| `PUT` | `/api/campaigns/:campaignId/communication-preferences` | user | Partial write |
| `PATCH` | `/api/campaigns/:campaignId/communication-preferences` | user | Alias for `PUT` |
| `DELETE` | `/api/campaigns/:campaignId/communication-preferences` | user | Reset to defaults |
| `GET` | `/api/users/me/communication-preferences` | user | Every campaign the caller muted something for |
| `DELETE` | `/api/users/me/communication-preferences` | user | Reset all of them |

### Deterministic behaviour

| Situation | Response |
| --- | --- |
| Campaign does not exist (or is soft-deleted) | `404 Campaign not found` |
| Unauthenticated | `401 Unauthorized` |
| Body with no recognised boolean channel | `422` + the list of valid channels |
| Unknown channel name, or a non-boolean value | ignored; only real booleans are written |
| `DELETE` with no stored row | `200` with the defaults (idempotent) |
| More than 30 writes/minute per user | `429` with `Retry-After` |

The `GET` endpoint resolves to the defaults when no row exists, so the UI never
has to special-case a missing record — and the endpoint cannot be used to probe
which campaign ids exist, because the campaign is loaded (and 404'd) first.

### Request shape

```http
PUT /api/campaigns/<id>/communication-preferences
{ "milestones": false, "surveys": true }
```

Only the keys present in the body are written:

```sql
INSERT INTO campaign_communication_preferences (campaign_id, user_id, milestones, surveys)
VALUES ($1, $2, $3, $4)
ON CONFLICT (campaign_id, user_id) DO UPDATE
  SET milestones = EXCLUDED.milestones,
      surveys = EXCLUDED.surveys,
      updated_at = NOW()
```

### Concurrent writes

`INSERT … ON CONFLICT (campaign_id, user_id) DO UPDATE` is atomic per row, so
two simultaneous toggles of *different* channels both survive (the second
statement only touches the channels it names). Two simultaneous toggles of the
*same* channel resolve last-write-wins, which is the expected semantics for a
boolean switch.

---

## Dispatch integration

Preferences are applied at the point of contact, not at the point of
configuration, so a mute takes effect for the next message.

### 1. Campaign updates — `services/campaignUpdatesPublishing.js`

Contributors are filtered through `filterEnabledUsers(campaignId, 'updates', …)`
before any in-app notification or email is created. The **fail-open** rule
matters: if the preference lookup itself errors, the full contributor list is
used and the error is logged, so a database hiccup can never silently mute
everybody.

The same filtered list is passed to `notifyFollowers` as the "already notified"
exclusion set, so nobody is pinged twice for the same update.

### 2. Follower fan-out — `services/campaignFollowService.js`

`notifyFollowers` gained a `NOT EXISTS` clause that drops any follower who
muted the channel mapped from their follow preference:

| Follow preference | Per-campaign channel |
| --- | --- |
| `notify_updates` | `updates` |
| `notify_milestones` | `milestones` |
| `notify_funding` | `funding_updates` |

The mapping is a static object (`CHANNEL_FOR_PREFERENCE`) and the existing
`PREFERENCE_COLUMNS` allow-list runs *before* the query, so no caller-supplied
string ever reaches the SQL text.

### 3. Outcome surveys — `services/outcomeSurveyService.js`

`notifyBackers` drops backers who muted `surveys`. See
[outcome surveys](outcome-surveys.md).

---

## Audit trail

Every change writes an `audit_logs` row:

```js
logAuditEvent({
  actorId: userId,
  action: 'campaign_communication_preferences_updated',  // or …_reset
  resourceType: 'campaign_communication_preference',
  resourceId: campaignId,
  metadata: { channels: ['milestones'], values: { milestones: false } },
  req,          // so the row records ip + user-agent
});
```

A rejected write (`422`) is **not** audited — the log only records changes that
actually happened. Audit failures never surface to the user: `auditPreferenceChange`
swallows and logs them, because losing an audit row is strictly better than
failing a preference toggle.

---

## User interface

- `frontend/src/components/CampaignCommunicationPreferences.jsx` — the panel on
  the campaign page. Optimistic toggles with rollback on failure, a
  `Reset to default` action that only appears once something is actually muted,
  and a help description wired to every checkbox via `aria-describedby`.
- `frontend/src/pages/NotificationSettings.jsx` — a "what should we tell you
  about" section listing every campaign the account has muted something for,
  with a reset-all action. It loads independently of the account-level switches,
  so a failure there cannot blank the settings page.

Both are fully localized (`en`, `fr`) and covered by the en/fr key-parity test.

---

## Operational notes

- **No configuration required.** The feature is on by default and there is no
  environment variable to set.
- **Write rate limit**: 30 writes/minute/user, 429 beyond that. Generous for a
  human, tight enough to stop a render loop from writing a row per frame.
- **Table size**: one row per (muted campaign, user). Realistically a few rows
  per user, so the table stays small; `idx_campaign_communication_preferences_user`
  serves the notification-settings listing without a sequential scan.
- **Index note**: `NOT EXISTS` in the follower fan-out hits
  `campaign_communication_preferences_pkey` (the composite primary key), so the
  per-follower check is an index lookup, not a scan.

---

## Tests

```
backend/src/services/communicationPreferenceService.test.js      19 cases
backend/src/routes/campaignCommunicationPreferences.test.js     11 cases
backend/src/services/campaignFollowService.test.js                3 added cases
backend/src/routes/outcomeSurveyDocs.test.js                     5 cases
frontend/src/test/components/CampaignCommunicationPreferences.test.jsx  9 cases
```

Covered: default resolution, partial-write semantics, unknown-key rejection,
`422` on an empty patch, idempotent reset, the audit payload shape, audit-failure
containment, channel allow-listing (SQL-injection guard), the `NOT EXISTS`
follower clause, every documented status code, and the full UI matrix
(load / empty / success / rollback-on-failure / reset).
