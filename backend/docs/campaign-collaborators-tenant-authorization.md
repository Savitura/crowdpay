# Tenant-Aware Authorization for Campaign Collaborators

## Overview

CrowdPay utilizes a multi-tenant isolation model where each campaign acts as its own autonomous tenant boundary identified by `campaign_id`. Access to campaigns, collaborator management, milestone submissions, fulfillments, updates, and analytics is governed on a strict per-campaign basis.

Campaign collaborators are users granted access to a specific campaign via `campaign_members`. A collaborator's permissions are strictly scoped to the campaign(s) where they hold an accepted membership.

---

## Authorization Architecture

### 1. Tenant Key and Scoping

- **Tenant Key:** `campaign_id` (UUID).
- **Membership Relation:** Stored in `campaign_members` keyed by `(campaign_id, user_id)`.
- **Enforcement Layers:**
  1. **Route Middleware (`requireCampaignMember`):** Resolves the target `campaign_id` from route parameters (`req.params.id`, `req.params.campaign_id`, or `req.body.campaign_id`), queries `campaign_members` strictly filtered by `campaign_id` and `req.user.userId`, and checks if the member's accepted role satisfies the required roles for that endpoint.
  2. **Service Resolution (`resolveUserCampaignRole`):** Given a `campaignId` and `userId`, evaluates campaign ownership (`creator_id === userId`) and accepted role in `campaign_members`.
  3. **SQL Scoping:** All collaborator mutation queries (`UPDATE`, `DELETE`, `INSERT`) explicitly include `WHERE campaign_id = $tenantId` to eliminate Indirect Object Reference (IDOR) attacks across campaigns.

### 2. Collaborator Role Hierarchy

Collaborators within a campaign tenant can hold one of five roles:

| Role      | Rank | Capabilities                                                                                                                                      |
| --------- | :--: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`   |  5   | Full administrative authority: edit details, manage/invite all roles, assign `owner` role, change roles, manage payouts/refunds, delete campaign. |
| `manager` |  4   | Operational leadership: invite/manage members (cannot grant `owner` role), post updates, submit milestones, manage fulfillments, view analytics.  |
| `editor`  |  3   | Content editor: edit campaign descriptions/details.                                                                                               |
| `finance` |  2   | Financial reviewer: review payouts/refunds, view contribution analytics.                                                                          |
| `viewer`  |  1   | Read-only collaborator: view private analytics and dashboards.                                                                                    |

Platform administrators (`role === 'admin'`) hold implicit global owner privileges across all campaigns.

---

## Tenant Isolation Guarantees

### 1. Cross-Tenant Denial (Privilege Isolation)

Holding a high-privilege role (`owner`, `manager`, `editor`) in Campaign Tenant A conveys **zero** privileges in Campaign Tenant B.

- Any request by Tenant A collaborators against Tenant B endpoints returns `403 Forbidden` (`Insufficient permissions for this campaign`).
- Unauthenticated requests return `401 Unauthorized`.
- Non-collaborators (strangers) attempting to access private campaign surfaces return `403 Forbidden`.

### 2. IDOR / Cross-Tenant Resource Parameter Tampering

Sub-resource identifiers (such as invitation IDs or user IDs) cannot be tampered across tenants. For example:

- Resending or canceling an invite belonging to Campaign B while issuing a request to Campaign A's path (`POST /api/campaigns/:tenantA/members/:tenantB_inviteId/resend`) fails with `404 Not Found` because the database query enforces `WHERE id = $memberId AND campaign_id = $campaignId`.
- Modifying or removing a member belonging to Campaign B while targeting Campaign A returns `404 Not Found`.

### 3. Multi-Tenant Dual-Role Independence

A single user account can hold different collaborator roles across different campaigns (e.g. `manager` in Campaign A and `viewer` in Campaign B).

- The user's management privileges are strictly confined to Campaign A.
- The user cannot post updates or invite members in Campaign B, despite their elevated status in Campaign A.
- Read permissions (such as viewing analytics) are granted in Campaign B in accordance with the `viewer` role.

### 4. Privilege Escalation Prevention

- Only owners may assign the `owner` role (`canAssignRole(actorRole, targetRole)`).
- Managers can invite managers, editors, finance, and viewers, but cannot create or promote new owners.

---

## Automated Test Coverage

The test suite in [`backend/src/routes/campaignCollaborators.tenant.test.js`](file:///c:/Users/pc/drips/chuks/crowdpay/backend/src/routes/campaignCollaborators.tenant.test.js) comprehensively covers:

1. **Primary Path (Intended Intra-Tenant Operations):**
   - Owners and managers listing tenant members (`GET /api/campaigns/:id/members`).
   - Inviting new collaborators within the tenant (`POST /api/campaigns/:id/members/invite`).
   - Updating member roles within the tenant (`PATCH /api/campaigns/:id/members/:userId`).
   - Resending pending invitations (`POST /api/campaigns/:id/members/:memberId/resend`).
   - Canceling pending invitations (`DELETE /api/campaigns/:id/members/invites/:memberId`).
   - Publishing campaign updates (`POST /api/campaigns/:id/updates`).
   - Accessing analytics dashboards (`GET /api/campaigns/:id/analytics`).
   - Collaborator self-removal / leaving team (`DELETE /api/campaigns/:id/members/:userId`).

2. **Cross-Tenant Denial:**
   - Collaborators on Tenant A forbidden from listing members on Tenant B (`403 Forbidden`).
   - Collaborators on Tenant A forbidden from inviting members to Tenant B (`403 Forbidden`).
   - Collaborators on Tenant A forbidden from modifying roles or removing members on Tenant B (`403 Forbidden`).
   - Collaborators on Tenant A forbidden from posting updates to Tenant B (`403 Forbidden`).
   - Collaborators on Tenant A forbidden from editing Tenant B details (`403 Forbidden`).
   - Collaborators on Tenant A forbidden from viewing Tenant B analytics or fulfillments (`403 Forbidden`).
   - Unknown campaigns return `404 Not Found`.

3. **Cross-Tenant IDOR and Parameter Tampering:**
   - Cross-tenant invite resend rejected with `404 Not Found`.
   - Cross-tenant invite cancellation rejected with `404 Not Found`.
   - Cross-tenant member role modification rejected with `404 Not Found`.
   - Cross-tenant member removal rejected with `404 Not Found`.
   - Cross-tenant self-removal from unjoined campaigns rejected with `404 Not Found`.

4. **Multi-Tenant Dual-Role Independence:**
   - Verified that a dual-role user (manager on Tenant A, viewer on Tenant B) cannot perform manager operations on Tenant B.
   - Verified manager-to-owner privilege escalation rejection.

5. **Platform Admin Override:**
   - Platform administrators retain administrative access across tenants without needing explicit `campaign_members` rows.

6. **Service-Level Tenant Isolation:**
   - `resolveUserCampaignRole` strictly scopes by `campaignId`.
   - `countAcceptedOwners` counts owners strictly within the designated tenant.
   - `createCampaignInvite` allows inviting a user to Tenant A who is already an accepted member of Tenant B without collision.
   - `resendCampaignInvite` and `cancelCampaignInvite` enforce tenant boundary checks.

---

## Impact Assessments

### Security

- **Confidentiality:** Restricts sensitive campaign metrics, financial reconciliations, backer profiles, and fulfillment shipping information strictly to authorized tenant collaborators.
- **Integrity:** Prevents unauthorized campaign edits, unauthorized updates, and cross-campaign member tampering.
- **Auditability:** All collaborator mutations are logged with the acting user's ID, action type, and campaign tenant ID.

### Privacy

- Contributor identities and shipping details are isolated to verified campaign managers/owners and are never exposed across tenant boundaries.

### Accessibility & Compatibility

- **API Compatibility:** All existing endpoints, request formats, and response schemas remain 100% backwards compatible.
- **Client Handling:** Standardized HTTP response codes (`401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `422 Validation Error`) are preserved, ensuring existing frontend client applications and SDKs handle responses without modification.

### Operational Performance

- Queries against `campaign_members` leverage existing compound indexes on `(campaign_id)` and `(campaign_id, user_id)` (`campaign_members_campaign_idx` and unique constraints), ensuring queries execute in sub-millisecond time.
