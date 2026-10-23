# Disaster-Relief Campaign Mode & Rapid Verification Workflow

## Overview

Disaster-relief campaign mode allows campaign creators and accepted campaign managers to attach an emergency response dossier to a campaign and submit it to a **4-hour SLA rapid verification queue**. Platform administrators can review submitted dossiers, grant a verified emergency response badge with rapid disbursement eligibility, request changes, reject submissions, or revoke verification if emergency conditions or partner authorizations change.

## Data Model & Schema

Defined in `backend/db/migrations/20261023_disaster_relief_campaigns.sql` and mirrored in `backend/db/schema.sql`:

1. **`campaign_disaster_relief`** (one row per campaign via `UNIQUE (campaign_id)`):
   - `incident_name` (`<= 160` chars)
   - `disaster_type` (`flood`, `earthquake`, `wildfire`, `hurricane`, `drought`, `conflict`, `epidemic`, `industrial`, `other`)
   - `severity_level` (`watch`, `urgent`, `critical`, `catastrophic`)
   - `affected_region` (`<= 200` chars)
   - `affected_population` (optional positive integer up to `100,000,000`)
   - `responder_organization` (optional, `<= 200` chars)
   - `emergency_contact` (internal 24/7 duty contact, `<= 200` chars)
   - `verification_badge` (optional badge label, default `"Verified Rapid Response"`)
   - `evidence_items` (`JSONB` array of up to 10 verified HTTPS documents/bulletins)
   - `status` (`draft`, `pending_review`, `verified`, `changes_requested`, `rejected`, `revoked`)
   - `rapid_disbursement_enabled` (`BOOLEAN`, automatically disabled upon revocation)
   - `submitted_at`, `reviewed_by`, `reviewed_at`, `review_note`, `revoked_by`, `revoked_at`, `revoked_reason`

2. **`campaign_disaster_relief_events`**:
   - Append-only lifecycle event log recording every state transition (`from_status`, `to_status`, `actor_id`, `note`, `metadata`, `created_at`).

## Verification State Machine

```
draft ──(submit)──► pending_review ──(verify)───────────► verified ──(revoke)──► revoked
  ▲                       │
  │                       ├──(request changes)──► changes_requested
  │                       │                              │
  │                       └──(reject)───────────► rejected
  └───────────────────────┴─────────(resubmit)───────────┘
```

All state transitions execute a compare-and-set `UPDATE ... WHERE status = $expected` query so concurrent requests cannot double-transition, double-audit, or send duplicate notifications.

## Security, Privacy, Operational & Accessibility Considerations

- **Privacy boundary**: Public reads (`GET /api/campaigns/:campaignId/disaster-relief`) return `disaster_relief: null` until a campaign is `verified` (or `revoked`). Even after verification, internal fields (`emergency_contact`, `review_note`, `revoked_reason`, `reviewed_by`, `revoked_by`) are stripped from public responses and only returned to the campaign creator, accepted managers, and admins.
- **SSRF & XSS hardening**: All text fields strip HTML tags and control characters. Every evidence item URL is validated to require `https:` and explicitly blocks `localhost`, `.local`, and loopback addresses (`127.0.0.1`, `0.0.0.0`, `::1`).
- **Operational SLA**: Dossiers in `pending_review` compute a live `sla` object (`target_hours: 4`, `due_at`, `remaining_ms`, `is_overdue`). The admin queue (`GET /api/campaigns/disaster-relief/queue`) orders pending submissions by severity (`catastrophic` -> `critical` -> `urgent` -> `watch`) and oldest `submitted_at` timestamp first.
- **Accessibility**: `DisasterReliefPanel.jsx` uses `<section aria-labelledby="disaster-relief-heading">`, `role="status"` and `role="alert"` live regions, and explicit `<label htmlFor="...">` bindings for all form controls.
