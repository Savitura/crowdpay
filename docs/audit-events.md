# Privileged audit events

High-impact campaign, payout, dispute, and administrative moderation actions write append-only rows to
`audit_logs`. Each row records:

- `actor_id` — the authenticated user, or `NULL` for system transitions;
- `action` — a stable verb such as `campaign.suspended`, `payout.approved`, or
  `dispute.resolved`;
- `resource_type` / `resource_id` — the affected target;
- `before_state` / `after_state` — sanitized state snapshots;
- `correlation_id` — the request ID propagated by `requestIdMiddleware`;
- `source` — request method and route (query strings removed) or a system job name;
- `metadata` — additional non-secret context;
- `ip_address` and `user_agent` for API-originated events.

## Covered actions

| Area                      | Actions                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campaigns                 | `campaign.suspended`, `campaign.restored`, `campaign.deleted`, `campaign.hidden`, `campaign.unhidden`, `campaign.status_changed` (funded/failed cron and refresh paths) |
| Administrative Moderation | `user.banned`, `user.unbanned`, `user.kyc_override`, `admin.impersonate_start`, `admin.impersonate_end`, `fraud.contribution_resolved`                                  |
| Payouts                   | `payout.approved`, `payout.rejected`, `payout.cancelled`, `milestone.released`, `milestone.rejected`                                                                    |
| Disputes                  | `dispute.status_changed`, `dispute.resolved`                                                                                                                            |

## Administrative Moderation Context

Administrative moderation actions performed via `/api/admin/*` and administrative moderation routes
capture structured audit context through `moderationAuditService`:

- **Actor Details**: `actor_id`, `actor_email`, and session role;
- **Target Metadata**: Human-readable entity labels (`campaign_title`, `target_user_email`, `target_role`) alongside target identifiers;
- **Justification & Rationale**: Explicit `reason` string supplied by the operator (mandatory for suspensions, deletions, and bans);
- **State Deltas**: Pre-action (`before_state`) and post-action (`after_state`) property snapshots;
- **Attribution & Origin**: Client `ip_address`, `user_agent`, and `correlation_id` propagated across layers;
- **Dual Persistence**: Every moderation event is recorded both to the tamper-evident append-only `audit_logs`
  table for compliance and security auditing, and to `admin_actions` with structured JSONB details for backward-compatible
  operational history.

## Redaction

Audit metadata, before state, and after state pass through
`auditService.sanitizeMetadata()` before persistence and again on read. Keys matching
password, secret, private key, seed, token, authorization, cookie, TOTP, XDR, signature,
HMAC, API key, or credential patterns are replaced with `[REDACTED]`. Stellar secret
seeds are also redacted by value. Circular references are replaced with `[Circular]`.

`audit_logs` is append-only: update, delete, and truncate privileges are revoked. There is
no application path that mutates or removes an audit row.

## Querying

Authorized administrators can read the trail at:

```text
GET /api/admin/audit-logs
GET /api/admin/audit-logs/export?format=csv
GET /api/admin/audit-log
```

Filters for `/api/admin/audit-logs`: `actor`, `action`, `resourceType`, `correlationId`, `source`, `dateFrom`,
`dateTo`, `limit`, `offset`. The route is protected by `requireAuth` plus `requireRole('admin')`.

Filters for `/api/admin/audit-log`: `action_type`, `target_type`, `target_id`, `admin_user_id`, `limit`, `offset`.
