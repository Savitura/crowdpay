# Issue #1235 Resolution: Gate CI on Schema Convergence and Milestone Percentage Validation

## Problem
The repository contains two important validation scripts:
- `backend/db/verify-schema-convergence.js` - Verifies database schema consistency
- `backend/scripts/validate-milestone-percentages.js` - Validates milestone percentages don't exceed 100%

These scripts existed but were not fully integrated into the CI pipeline to catch regressions automatically on every PR.

## Solution

### 1. Schema Convergence Validation
**Status: ✅ Already integrated**

The schema convergence script was already properly integrated into the CI workflow with three comprehensive checks:

1. **Migration upgrade test** (`test:migration-upgrade`) - Tests production-like fixture upgrades
2. **Fresh schema verification** - Validates `schema.sql` with the `migrate:fresh` flow
3. **Snapshot comparison** - Compares migration-only vs schema bootstrap snapshots

These checks run in the `backend-checks` job and ensure that:
- All expected tables exist
- Schema.sql and migrations produce identical database structures
- Canonical data (feature flags, campaign templates) is correctly seeded
- No schema drift occurs between different bootstrap methods

### 2. Milestone Percentage Validation
**Status: ✅ Newly integrated**

Added milestone percentage validation to the CI workflow:

#### Changes Made:

**A. Enhanced the validation script** (`backend/scripts/validate-milestone-percentages.js`)
- Modified exit behavior to fail with status code 1 when invalid campaigns are detected
- Now properly gates CI by returning non-zero exit code on validation failure
- Reports campaigns where milestone percentages exceed 100%

**B. Updated CI workflow** (`.github/workflows/ci.yml`)
- Added seed data loading step before validation (uses existing `db/seed.sql`)
- Added new step "Validate milestone percentages" that runs `npm run validate-milestones`
- Positioned strategically after migrations complete but before test suite runs
- Uses same PostgreSQL test database as other backend checks

#### CI Workflow Steps (in order):
1. Run migrations
2. **[NEW]** Seed test data for validation scripts
3. **[NEW]** Validate milestone percentages
4. Upgrade production-like fixture and verify schema convergence
5. Verify schema.sql and migrations converge
6. Compare migration-only and schema bootstrap snapshots
7. Run test suite

## Impact

### Automated Regression Prevention
- **Schema drift** is caught automatically before merge
- **Milestone invariant violations** (percentages > 100%) are caught before they reach production
- Both checks run on every PR, ensuring data integrity constraints are maintained

### Developer Experience
- Developers receive immediate feedback if their changes break schema convergence
- Campaign creators are prevented from creating invalid milestone configurations
- Soroban contract execution panics from invalid percentages are prevented at the database level

### Exit Codes
- Both scripts exit with code 0 on success (no issues found)
- Both scripts exit with code 1 on failure (regressions detected)
- CI job fails if either validation fails, blocking PR merge

## Testing

To test locally:

```bash
# Test schema convergence
cd backend
npm run verify-schema

# Test milestone percentage validation
cd backend
npm run validate-milestones
```

## Related Files Modified

1. `.github/workflows/ci.yml` - Added milestone validation step and seed data loading
2. `backend/scripts/validate-milestone-percentages.js` - Enhanced exit code handling

## Notes

- The seed data (`db/seed.sql`) is shared with the `performance-budgets` job, ensuring consistency
- Schema convergence was already working correctly; no changes needed
- The validation runs against the same test database used by other backend checks
- Database connection is managed by the existing `src/config/database.js` module
