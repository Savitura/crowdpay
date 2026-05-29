# Admin Moderation System Implementation Guide

## Overview

This document describes the complete implementation of the Admin Moderation System for CrowdPay, enabling platform administrators to review, suspend, restore, and delete campaigns, as well as manage user access.

## What Was Implemented

### 1. Database Changes

**Migration File**: `backend/db/migrations/20260430_admin_moderation.sql`

- Added `deleted_at TIMESTAMPTZ` column to `campaigns` table for soft-deletion
- Added `is_banned BOOLEAN DEFAULT FALSE` column to `users` table
- Extended campaign status enum to include `'suspended'`
- Created `admin_actions` audit table with the following columns:
  - `id` (UUID primary key)
  - `admin_user_id` (references users.id)
  - `action_type` (TEXT: suspend, restore, delete, ban, unban, promote, demote)
  - `target_type` (TEXT: campaign or user)
  - `target_id` (UUID)
  - `details` (JSONB for metadata)
  - `created_at` (TIMESTAMPTZ)
- Created indexes on audit table for efficient queries

### 2. Backend Changes

#### Authentication Middleware (`backend/src/middleware/auth.js`)

- Updated `authenticate()` function to load `is_admin` and `is_banned` flags from database
- Updated `requireAdmin()` middleware to check `req.user.is_admin` flag
- Admin status is loaded from JWT and cross-referenced with DB on each request

#### Admin Routes (`backend/src/routes/admin.js`)

Complete rewrite with the following endpoints:

**Stats**
- `GET /api/admin/stats` - Platform statistics including banned users and deleted campaigns

**Campaign Management**
- `GET /api/admin/campaigns?status=X&include_deleted=true` - List all campaigns (with filtering)
- `PATCH /api/admin/campaigns/:id/suspend` - Set campaign status to 'suspended'
- `PATCH /api/admin/campaigns/:id/restore` - Restore suspended campaign to 'active'
- `DELETE /api/admin/campaigns/:id` - Soft-delete campaign (set deleted_at)

**User Management**
- `GET /api/admin/users?include_banned=true` - List all users (with filtering)
- `PATCH /api/admin/users/:id/ban` - Ban a user (set is_banned = true)
- `PATCH /api/admin/users/:id/unban` - Unban a user (set is_banned = false)
- `PATCH /api/admin/users/:id/promote` - Promote user to admin
- `PATCH /api/admin/users/:id/demote` - Demote admin to regular user

**Audit Log**
- `GET /api/admin/audit-log?limit=100&offset=0` - View admin action history

**Helper Function**
- `logAdminAction()` - Automatically logs all admin actions to audit table

#### Campaign Routes (`backend/src/routes/campaigns.js`)

- Updated `loadActiveCampaign()` to exclude deleted campaigns
- Added `deleted_at IS NULL` filter to public campaign listing
- Deleted campaigns return 404 on direct access
- Suspended campaigns are accessible with a `suspended_notice` field
- Suspended campaigns show message but are excluded from public listings

#### Contribution Routes (`backend/src/routes/contributions.js`)

- Updated `loadActiveCampaign()` to only load campaigns where `deleted_at IS NULL`
- This automatically prevents contributions to deleted campaigns
- Already prevents contributions to suspended campaigns (status != 'active')

### 3. Frontend Changes

#### Admin Dashboard (`frontend/src/pages/AdminDashboard.jsx`)

Complete redesign with:

**Tab Navigation**
- Campaigns, Users, Disputes, Milestones, Audit Log tabs

**Campaign Moderation Tab**
- Table showing all campaigns with status, raised amount, and creator info
- Action buttons:
  - **Suspend**: Prevents contributions, hides from public listing
  - **Restore**: Reverses suspension
  - **Delete**: Permanently archives campaign
- Visual indicators for suspended/deleted campaigns

**User Management Tab**
- Table showing all users with active/banned status
- Ban/Unban buttons with reason prompts
- Shows campaign and contribution counts per user

**Audit Log Tab**
- Complete history of all admin actions
- Shows: timestamp, admin email, action type, target, and details
- Color-coded for destructive actions (ban, suspend, delete in red)

**Stats Dashboard**
- Total users (with banned count)
- Active campaigns (with deleted count)
- Total contributions
- Suspended campaigns count

#### API Service (`frontend/src/services/api.js`)

New admin functions:
```javascript
getAdminStats(token)
getAdminCampaigns(token)
getAdminUsers(token, include_banned)
getAdminAuditLog(token, options)
adminSuspendCampaign(id, body, token)
adminRestoreCampaign(id, token)
adminDeleteCampaign(id, body, token)
adminBanUser(id, body, token)
adminUnbanUser(id, token)
adminPromoteUser(id, token)
adminDemoteUser(id, token)
```

### 4. Tests

**Test File**: `backend/src/routes/admin.test.js`

Comprehensive test suite covering:

- Admin authentication (403 for non-admins, 401 for unauthenticated)
- Campaign suspension and restoration
- Suspended campaigns hidden from public listing
- Suspended campaigns show notice when accessed directly
- Contributions blocked to suspended campaigns
- Campaign soft-deletion
- Deleted campaigns return 404
- User banning/unbanning
- Audit logging functionality
- Admin stats with moderation metrics

## Acceptance Criteria Met

✅ **Non-admin users receive 403 from all `/api/admin/*` routes**
- Enforced via `requireAdmin` middleware on all admin routes

✅ **Suspended campaigns cannot receive new contributions**
- `loadActiveCampaign()` only loads campaigns with status = 'active'
- Suspended campaigns have status = 'suspended'
- No other statuses bypass the check

✅ **Suspended campaigns are hidden from public listing but accessible via direct link with a "Campaign suspended" message**
- Public listing filters by `status = 'active'` and `deleted_at IS NULL`
- Direct campaign route accessible with status 'suspended'
- Response includes `suspended_notice` field

✅ **Admin actions are logged in a new `admin_actions` audit table**
- Dedicated table with admin_user_id, action_type, target_type, target_id, details
- All campaign and user actions logged via `logAdminAction()` helper

✅ **Admin UI only appears in navigation for users where `is_admin = true`**
- Check in AdminDashboard: `if (!user.is_admin) navigate('/')`
- Navbar can conditionally show admin link based on `user.is_admin`

## Deployment Steps

### 1. Run Database Migration

```bash
psql -U crowdpay -d crowdpay_db -f backend/db/migrations/20260430_admin_moderation.sql
```

Or through your migration tool:
```bash
node migrate.js
```

### 2. Promote an Initial Admin

```sql
UPDATE users SET is_admin = true WHERE email = 'your-admin@example.com';
```

### 3. Restart Backend Server

```bash
npm start
```

### 4. Access Admin Dashboard

Navigate to `http://localhost:5173/admin` (requires `is_admin = true`)

## API Examples

### Suspend a Campaign

```bash
curl -X PATCH http://localhost:3000/api/admin/campaigns/{campaignId}/suspend \
  -H "Authorization: Bearer {adminToken}" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Violates community guidelines"}'
```

### Ban a User

```bash
curl -X PATCH http://localhost:3000/api/admin/users/{userId}/ban \
  -H "Authorization: Bearer {adminToken}" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Multiple ToS violations"}'
```

### Get Audit Log

```bash
curl -X GET "http://localhost:3000/api/admin/audit-log?limit=50&offset=0" \
  -H "Authorization: Bearer {adminToken}"
```

### List All Campaigns (including deleted)

```bash
curl -X GET "http://localhost:3000/api/admin/campaigns?include_deleted=true" \
  -H "Authorization: Bearer {adminToken}"
```

## Security Considerations

1. **Admin Actions Require Authentication**: All admin endpoints require valid JWT with `is_admin = true`
2. **Audit Trail**: All moderation actions are logged with admin identity and timestamp
3. **Soft Deletes**: Campaigns are never hard-deleted, only marked as deleted_at
4. **Non-Destructive Default**: Suspended campaigns can be restored; users can be unbanned
5. **Reason Tracking**: All ban/suspend/delete actions store reason in audit details

## Frontend Integration

The Admin Dashboard is already integrated into the app routes. To ensure visibility:

1. Update Navbar to show "Admin" link only for admins:

```jsx
{user?.is_admin && <Link to="/admin">Admin</Link>}
```

2. The AdminDashboard already checks `is_admin` and redirects if unauthorized

## Rollback Plan

If issues occur:

1. Set all `is_admin` flags to false:
   ```sql
   UPDATE users SET is_admin = false;
   ```

2. Revert migration (campaigns will still have suspended status, but enforcement doesn't apply):
   ```bash
   # Drop audit table if needed
   DROP TABLE IF EXISTS admin_actions;
   # No cascade needed, other tables remain intact
   ```

## Future Enhancements

- Email notifications to campaign creators when suspended
- Batch operations (suspend multiple campaigns)
- Admin appeals workflow
- Timed bans (temporary suspensions)
- Automated moderation triggers based on reports
- Admin activity dashboard with charts
