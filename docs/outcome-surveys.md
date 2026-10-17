# Beneficiary outcome surveys (#960)

**Status**: shipped.

---

## Why

CrowdPay can tell you that money moved. It could not tell you whether anything
actually got built. Every other crowdfunding platform treats "did it work?" as
the most valuable signal a backer has, and the backer is the only person who
knows.

This feature lets a creator close a campaign and then ask the people who funded
it what happened. "Beneficiary" here means **a contributor to that specific
campaign** — eligibility is derived from the contribution ledger, not from
follow rows or account role, because the survey is research *from the people who
put money in*.

---

## Lifecycle

```
        create (POST)          open (POST /open)          close (POST /close)
  ──────────────────▶ draft ──────────────────▶ open ──────────────────▶ closed
                         │                       │                        │
                    edit (PUT)             respond (POST)            read results
```

`TRANSITIONS` in `outcomeSurveyService.js` is the single source of truth and is
a **closed** state machine: nothing reopens a survey, and every transition is a
compare-and-set `UPDATE … WHERE status = <expected>` so a concurrent caller
loses the race and gets a `409` instead of double-notifying every backer.

| From | To |
| --- | --- |
| `draft` | `open`, `closed` |
| `open` | `closed` |
| `closed` | — |

---

## Data model

`backend/db/migrations/20261002_campaign_outcome_surveys.sql`

### `campaign_outcome_surveys`

One survey per campaign (`UNIQUE (campaign_id)`), so the duplicate-create path is
a deterministic `409` rather than a race.

| Column | Notes |
| --- | --- |
| `questions` | `JSONB` array of `{ id, prompt, type, required, options }`; `CHECK jsonb_typeof = 'array'` |
| `status` | `CHECK IN ('draft','open','closed')` |
| `opens_at` / `closes_at` | `CHECK closes_at > opens_at` when both are set |
| `published_at` / `closed_at` | transition timestamps |
| `title` / `intro` | `CHECK char_length <= 200` / `<= 2000` |

### `campaign_outcome_survey_responses`

`UNIQUE (survey_id, user_id)` is the **arbiter** for duplicate submissions: two
concurrent posts produce one `201` and one `409`, never two rows. The insert uses
`ON CONFLICT DO NOTHING` and a zero-row result is reported as the `409`.

### `campaign_outcome_survey_events`

Append-only lifecycle trail (created / published / closed) surfaced at
`GET …/events` and mirrored into `audit_logs`.

---

## Question types and limits

| Limit | Value | Enforced in |
| --- | --- | --- |
| Questions per survey | 10 | `validateQuestions` |
| Prompt length | 500 | `validateQuestions` |
| Options per single-choice question | 2–10, must be distinct | `validateQuestions` |
| Option length | 200 (truncated) | `validateQuestions` |
| Rating range | integer 1–5 | `validateAnswers` |
| Free-text answer | 2000 (trimmed) | `validateAnswers` |

| Type | Answer shape |
| --- | --- |
| `rating` | integer 1–5 (numeric strings accepted; `true`/`null` are **not**) |
| `single_choice` | a string that exactly matches one of the question's `options` |
| `text` | a string, trimmed, length-capped |

### Question ids are derived, not supplied

`slugify(prompt)` produces a stable id, so re-saving a draft cannot orphan
already-collected answers. Duplicate prompts are disambiguated with a `_2`, `_3`
suffix rather than rejected, and a client-supplied id is honoured when present
so an older survey keeps working.

### Validation happens twice, on purpose

`validateAnswers` re-validates every submission against the **stored** question
set. A survey cannot be edited once open (`409`), so a stale client cannot
submit ids that no longer exist, skip a required question, or smuggle a
free-text payload into a rating field.

---

## API

Mounted at `/api/campaigns` from `backend/src/routes/outcomeSurveys.js`.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/:campaignId/outcome-survey` | public (`optionalAuth`) | Survey + aggregate count + *your own* response |
| `POST` | `/:campaignId/outcome-survey` | owner / accepted manager / admin | Create the draft |
| `PUT` | `/:campaignId/outcome-survey` | owner / accepted manager / admin | Edit the draft |
| `POST` | `/:campaignId/outcome-survey/open` | owner / accepted manager / admin | Publish + invite backers |
| `POST` | `/:campaignId/outcome-survey/close` | owner / accepted manager / admin | Stop accepting responses |
| `POST` | `/:campaignId/outcome-survey/respond` | any contributor to this campaign | Submit answers |
| `GET` | `/:campaignId/outcome-survey/results` | owner / accepted manager / admin | Aggregates |
| `GET` | `/:campaignId/outcome-survey/events` | owner / accepted manager / admin | Lifecycle trail |

### Campaign eligibility

A survey can only be created once the campaign has finished funding:
`completed`, `funded`, `in_progress`, or `closed`. Any other status is a `409`
that names the current status, and the list is an explicit constant
(`SURVEY_ELIGIBLE_CAMPAIGN_STATUSES`) so an unfamiliar status fails closed.

### Deterministic behaviour

| Situation | Response |
| --- | --- |
| Unknown / soft-deleted campaign | `404 Campaign not found` |
| Not the creator, an accepted `owner`/`manager`, or an admin | `403` |
| A `viewer` or `editor` member, or a pending invite | `403` |
| Second survey for the same campaign | `409 An outcome survey already exists…` |
| Edit while `open`/`closed` | `409` (in-flight answers are never re-scoped) |
| Publish a draft with zero questions | `409` |
| `closes_at` in the past | `422` |
| Respond to a non-`open` survey | `409` |
| Respond after `closes_at` | `409` |
| Respond when you never contributed | `403` |
| Respond twice | `409` |
| Malformed / unknown-question / out-of-range answers | `422` + the offending field |
| More than 10 submissions/minute/user | `429` |

### Tenancy boundary

`isBeneficiary(campaignId, userId)` joins `contributions` to `users` on
`wallet_public_key` and is checked on **every** submission. A signed-in user who
never backed the campaign cannot read or write a response, and — because
answers are validated *before* the ownership lookup — a malformed payload cannot
be used to probe who contributed.

### Privacy

- `GET …/outcome-survey` returns the survey, the aggregate `response_count`, and
  the caller's own `my_response`. It never selects anybody else's row.
- `GET …/outcome-survey/results` is owner-only and selects `answers` **without**
  `user_id`. Free text is aggregated by frequency with a **20-answer cap** on
  retained samples, so a survey with long answers cannot grow the payload
  without bound.
- There is no endpoint that lists respondents.

---

## Notification on publish

`openSurvey` fans a single in-app notification out to every distinct backer,
minus:

- the publishing actor, and
- anyone who muted the `surveys` channel for this campaign (see
  [communication preferences](contributor-communication-preferences.md)).

`notifyBackers` is best-effort: a notification failure is logged and reported
as `invited: 0` rather than rolling back a survey that is already published.

---

## User interface

### Backer — `components/campaign/OutcomeSurveyPanel.jsx`

Every state the API can produce has an explicit rendering:

| State | Rendering |
| --- | --- |
| loading | `role="status"` skeleton text |
| no survey, or an unpublished draft | quiet empty state (never a 404) |
| `open` + not yet responded | the form, one control per question type |
| `open` + already responded | confirmation, form removed |
| `open` + viewer who is not a backer | explanation, form removed |
| `closed` | read-only, closed badge |
| load failure | `role="alert"` with the server message |

The required marker is rendered **outside** the `<label>` so the control's
accessible name stays exactly the question text.

### Creator — `components/campaign/OutcomeSurveyEditor.jsx`

Draft builder (title, intro, add/remove questions, per-type options, required
toggles), publish and close actions, an aggregate results view, and the
lifecycle trail. Publishing is disabled until a draft exists, and a validation
error from the API leaves the typed draft in place.

Both components are fully localized (`en`, `fr`) and pass the en/fr key-parity
test.

---

## Operational notes

- **No configuration required.** No cron, no feature flag, no env var.
- **Write rate limit**: 10 submissions/minute/user on `respond`.
- **Table size**: `campaign_outcome_surveys` is capped at one row per campaign.
  `campaign_outcome_survey_responses` grows with `(survey, backer)` pairs;
  `idx_campaign_outcome_survey_responses_survey` serves both the aggregate count
  and the results aggregation, and `idx_campaign_outcome_survey_responses_user`
  serves the "did I already answer?" lookup.
- **Results are computed on read.** At the expected scale (one response per
  backer per campaign) that is cheaper than maintaining rollups. If a campaign
  ever needs cached aggregates, the aggregation is isolated in
  `getResults`.

---

## Tests

```
backend/src/services/outcomeSurveyService.test.js   53 cases
backend/src/routes/outcomeSurveys.test.js           28 cases
backend/src/routes/outcomeSurveyDocs.test.js         5 cases
frontend/src/test/components/OutcomeSurveyPanel.test.jsx  13 cases
frontend/src/test/components/OutcomeSurveyEditor.test.jsx 13 cases
```

Covered: every validation limit, `Number(true) === 1` and `Number(null) === 0`
rejection, duplicate-prompt id disambiguation, unknown-question rejection, the
campaign-eligibility matrix, all nine lifecycle transitions including the
concurrent-open and concurrent-submit races (both assert that the loser
notifies nobody and writes nothing), non-contributor `403`, closed-survey
`409`, idempotent close, the aggregate maths (average, distribution, skips, the
20-sample cap), the privacy assertions (no `user_id` in the results query, only
the caller's own response on the public read), and the full UI state matrix
including failure rollback.
