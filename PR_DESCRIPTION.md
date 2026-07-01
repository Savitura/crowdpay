# PR #436: Feature Flags System for Gradual Rollouts and A/B Testing

**Closes #436**

---

## Overview

Adds a lightweight feature flag service supporting env-based static flags, deterministic percentage-based rollouts, per-user/per-role targeting, and A/B test variant assignment — with an extensible adapter pattern for Unleash/LaunchDarkly integration.

## Files Changed

| File | Status | Description |
|------|--------|-------------|
| `backend/src/services/featureFlags.js` | **New** | Core feature flag service (280 lines) |
| `backend/src/services/featureFlags.test.js` | **New** | 32 unit tests for the service |
| `backend/db/schema.sql` | Modified | Added `feature_flags` DB table |
| `backend/src/index.js` | Modified | Migrated 4 cron/serve-frontend checks to use feature flags |
| `backend/src/services/kycProvider.js` | Modified | Migrated `isKycRequiredForCampaigns()` to use feature flags |

## Feature Flag Service API

### Core Methods

```js
const ff = require('./featureFlags');

// Check if a flag is enabled for the current context
ff.isEnabled('flag-name', { userId, role });

// Get A/B test variant assignment (returns 'control', 'treatment', or null)
ff.getVariant('flag-name', { userId });

// Get snapshot of all flags with resolved states
ff.getAllFlags({ userId, role });

// Express middleware — gate routes behind feature flags
router.get('/new-feature', ff.requireFlag('new-dashboard', { behavior: '404' }), handler);

// Override flags for testing or admin panels
ff.setOverride('flag-name', true);
ff.clearOverrides();

// Integrate Unleash / LaunchDarkly adapter
ff.registerAdapter('flag-name', { isEnabled: (name, ctx) => boolean });
ff.syncFlagsToAdapter(adapter);
```

### Flag Evaluation Priority

1. In-memory override (`setOverride`)
2. Registered external adapter (Unleash, LaunchDarkly)
3. Per-user allowlist (`allowedUserIds`)
4. Per-role allowlist (`allowedRoles`)
5. Percentage rollout bucket (deterministic SHA-256, 0–99%)
6. Environment variable
7. Flag's `defaultValue`

### Built-in Flags

| Flag Name | Env Var | Default | Description |
|-----------|---------|---------|-------------|
| `campaign-status-cron` | `ENABLE_CAMPAIGN_STATUS_CRON` | `true` | Hourly campaign status job |
| `kyc-required-for-campaigns` | `KYC_REQUIRED_FOR_CAMPAIGNS` | `true` | Require KYC for campaign creation |
| `reconciliation-cron` | `ENABLE_RECONCILIATION_CRON` | `true` | On-chain balance reconciliation |
| `serve-frontend` | `SERVE_FRONTEND` | `false` | Serve frontend SPA from backend |
| `weekly-digest-cron` | `ENABLE_WEEKLY_DIGEST_CRON` | `true` | Weekly contributor email digests |

## DB Schema

The `feature_flags` table supports dynamic DB-backed flags with:

- `rollout_pct` — 0–100 percentage for gradual rollout
- `target_roles` — Role allowlist (e.g. `['admin', 'creator']`)
- `target_user_ids` — User UUID allowlist
- `variants` — JSONB for A/B test variant configuration

## Testing

All 36 relevant tests pass:

- 32 feature flag unit tests (env vars, overrides, percentage rollouts, variants, adapters, middleware)
- 4 kycService integration tests (backward compatible)

---

## Commit Message (for `git commit`)

```
feat: add feature flags system for gradual rollouts and A/B testing

Implement a lightweight feature flag service with:
- Env-based static flags for simple on/off toggles
- Deterministic percentage-based rollouts via SHA-256 bucketing
- Per-user and per-role flag targeting (allowedUserIds, allowedRoles)
- A/B test variant assignment via getVariant(name, context)
- Express middleware for route-level gating (requireFlag)
- Adapter pattern for Unleash/LaunchDarkly integration
- In-memory overrides for testing and admin debug panels

Add feature_flags DB table with rollout_pct, target_roles,
target_user_ids, and variants columns for dynamic flag management.

Migrate existing env-based toggles to use the new service:
- ENABLE_CAMPAIGN_STATUS_CRON → campaign-status-cron
- ENABLE_RECONCILIATION_CRON → reconciliation-cron
- ENABLE_WEEKLY_DIGEST_CRON → weekly-digest-cron
- SERVE_FRONTEND → serve-frontend
- KYC_REQUIRED_FOR_CAMPAIGNS → kyc-required-for-campaigns

Closes #436
```

---

## How to Submit the PR

1. Push the branch from this machine:
   ```bash
   git push origin feat/feature-flags-system
   ```

2. Or push from your other account:
   ```bash
   git remote add my-fork https://github.com/YOUR_USERNAME/crowdpay.git
   git push my-fork feat/feature-flags-system
   ```

3. Create the PR at:
   https://github.com/Savitura/crowdpay/compare/feat/feature-flags-system?expand=1

4. Copy the PR description above into the PR body.
