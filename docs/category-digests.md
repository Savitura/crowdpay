# Category follows & digest

Users can follow campaign categories (`technology`, `community`, `arts`,
`education`, `environment`, `health`, `business`, `open_source`, `other`) and
receive matching campaigns inside the existing weekly digest email.

## User flow

1. **Discover** (`/discover`): each category pill shows a Follow / Following
   toggle when logged in (loading → toggle → success with optimistic update,
   failure reverts and shows an error).
2. **Notification settings** (`/settings/notifications`): the
   `Followed Categories` section lists every category with follower and
   active-campaign counts, plus empty (`You are not following any categories
   yet`), loading, and failure-with-retry states.
3. **Digest**: followed categories contribute up to 5 new campaigns each
   (max 20 total) to the weekly email under a `New in <category>` heading.
   The `Category digest` master switch in notification settings opts out
   without unfollowing.

## API

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/categories` | optional | `200` list with `follower_count`, `active_campaigns`, `following` | Public, `Cache-Control: max-age=60` |
| `GET` | `/api/users/me/category-follows` | required | `200` `[{category, followed_at}]` | Scoped to caller |
| `POST` | `/api/users/me/category-follows` | required | `201` created / `200` repeat (`{category, following, created}`) | Idempotent; `400 VALIDATION_ERROR` on unknown category |
| `DELETE` | `/api/users/me/category-follows/:category` | required | `204` always (even if not following) | Idempotent; `400` on unknown category |
| `GET/PATCH` | `/api/users/me/notification-preferences` | required | includes `category_digest` (default `true`) | Master digest switch |

Validation errors use the shared envelope
`{ error: { code: 'VALIDATION_ERROR', message, fields } }`.
`401` when unauthenticated. Follow/unfollow are audited as
`category_followed` / `category_unfollowed` on resource type
`category_follow` (metadata contains only the category — no PII).

## Operational behavior & limits

- **Persistence**: `category_follows (user_id, category)` PK; cascade delete
  with the user. Migration `20260930_category_follows.sql` is additive and
  re-runnable (`IF NOT EXISTS`); `schema.sql` declares the same objects so
  `migrate:fresh --bootstrap-schema` converges.
- **Duplicate / concurrent**: `INSERT … ON CONFLICT DO NOTHING` + follow-up
  `SELECT` — concurrent double-taps resolve to one row (`created: false`).
- **Digest cadence**: the existing `weekly-digest-cron` worker (hourly tick,
  `sendWeeklyContributorDigests`) now also includes category followers.
  Recipients are users with contributions **or** category follows, excluding
  `email_unsubscribes` (`weekly_digest`, `category_digest`) and
  `notification_preferences.category_digest = FALSE`.
- **Dedupe**: a backed campaign in a followed category appears once
  (`isNew` flag drives the heading). Delivery is recorded once per
  `(user_id, 'weekly_digest', window_ended_at)` via
  `ON CONFLICT DO NOTHING`.
- **Caps**: ≤ 5 campaigns per category, ≤ 20 total per digest; digest emails
  are sent idempotently (`weekly_digest:<userId>:<windowEnd>`).
- **Rate limits**: follow/unfollow writes limited to 60/min per user (429
  with `RATE_LIMITED`).
- **Unsubscribe**: digest footer links map `category_digest` →
  `notification_preferences.category_digest = FALSE`; `weekly_digest` →
  `marketing = FALSE` (unchanged).
- **Exports**: `category_follows` rows are included in the user data export.
- **Config**: no new env vars. Disable with the existing
  `weekly-digest-cron` feature flag (`ENABLE_WEEKLY_DIGEST_CRON=false` or
  `WORKER_ENABLED=false`); email delivery still requires `SMTP_HOST` or
  `EMAIL_SERVICE_API_KEY` (else `/health` reports `email: "unconfigured"`
  and sends are skipped).

## Testing

- `categoryFollowService.test.js`: validation, idempotent create/repeat,
  concurrent race, scoping, per-category caps.
- `categoryFollows.test.js`: public list, 201/200/204 flows, 400 envelope,
  401, user isolation, case-insensitive input.
- `weeklyDigestService.category.test.js`: follower-only recipient,
  backed+followed dedupe, `category_digest = FALSE` exclusion.
- Existing `weeklyDigestService.test.js` + `users.preferences.test.js`
  updated for the extended recipient query and `category_digest` field.
