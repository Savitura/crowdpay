# PR #196: Add Soft Delete for Campaigns — Preserve Data and Allow Recovery

## Issue
There is currently no delete endpoint for campaigns. If one were added, a hard delete (DELETE FROM campaigns WHERE id = $1) would:
- Cascade-delete all contributions, withdrawals, and stellar_transactions (via FK ON DELETE CASCADE)
- Permanently lose on-chain contribution history that can be verified on Stellar but not in the app
- Make it impossible to recover a campaign deleted by mistake

## Solution: Soft Delete with deleted_at
Add a `deleted_at` timestamp column to the campaigns table. A deleted campaign is not removed from the database but marked as deleted and hidden from public queries.

### Changes Made

**File: `backend/db/migrations/20260602_add_campaign_soft_delete.sql`**
- Added `deleted_at TIMESTAMPTZ` column to campaigns table
- Created partial index on `deleted_at` WHERE deleted_at IS NULL for performance

**File: `backend/src/routes/campaigns.js`**

1. **Updated campaign queries to filter deleted campaigns** (multiple locations)
   - Line 53: requireCampaignMember middleware - added `AND deleted_at IS NULL`
   - Line 352: milestones endpoint - added `AND deleted_at IS NULL FOR UPDATE`
   - Line 450: GET /:id endpoint - added `AND c.deleted_at IS NULL`
   - Line 514: embed endpoint - added `AND deleted_at IS NULL`
   - Line 552: backers endpoint - added `AND deleted_at IS NULL`
   - Line 580: stream endpoint - added `AND deleted_at IS NULL`
   - Line 643: balance endpoint - added `AND deleted_at IS NULL`
   - Line 205: list endpoint already had `c.deleted_at IS NULL` filter

2. **Added DELETE endpoint** (lines 1466-1501)
   - Route: `DELETE /api/campaigns/:id`
   - Requires authentication (creator only)
   - Checks for pending withdrawals before allowing deletion
   - Returns 409 if campaign has pending withdrawal
   - Soft deletes by setting `deleted_at = NOW()`
   - Returns 404 if campaign not found or already deleted
   - Returns `{ deleted: true }` on success

3. **Added admin restore endpoint** (lines 1503-1518)
   - Route: `POST /api/admin/campaigns/:id/restore`
   - Requires authentication and admin role
   - Restores soft-deleted campaign by setting `deleted_at = NULL`
   - Returns `{ restored: true }` on success

**File: `frontend/src/services/api.js`**
- Added `deleteCampaign: (id) => request('DELETE', `/campaigns/${id}`)` function (line 208)

**File: `frontend/src/pages/Campaign.jsx`**

1. **Added state variables** (lines 173-177)
   - `showDeleteDialog` - controls confirmation dialog visibility
   - `deleteConfirmation` - stores user's typed confirmation
   - `deleteLoading` - loading state during deletion
   - `deleteError` - error message display
   - `hasPendingWithdrawal` - tracks if campaign has pending withdrawal

2. **Added pending withdrawal check** (lines 217-226)
   - Fetches withdrawals when campaign loads
   - Sets `hasPendingWithdrawal` to true if any withdrawal has status "pending"

3. **Added handleDeleteCampaign function** (lines 461-483)
   - Validates confirmation matches campaign title
   - Calls API to delete campaign
   - Redirects to home on success
   - Handles errors appropriately

4. **Added delete button to UI** (lines 858-874)
   - Visible only to creator when campaign is active and has no pending withdrawal
   - Styled with red color to indicate destructive action
   - Opens confirmation dialog on click

5. **Added confirmation dialog** (lines 1713-1835)
   - Modal overlay with backdrop
   - Requires user to type campaign title to confirm
   - Shows warning about irreversible action
   - Disabled delete button until confirmation matches
   - Cancel button to dismiss dialog
   - Error message display for validation failures

## Acceptance Criteria
- ✅ DELETE /api/campaigns/:id soft-deletes by setting deleted_at = NOW()
- ✅ Deleted campaigns return 404 from all public endpoints
- ✅ Deletion is blocked when a pending withdrawal exists
- ✅ Creator must confirm by typing the campaign title before deletion
- ✅ Contribution and withdrawal history is preserved in the database
- ✅ Admin can restore a soft-deleted campaign via POST /api/admin/campaigns/:id/restore

## Testing Instructions

### 1. Run the database migration
```bash
cd backend
psql -U your_user -d your_database -f db/migrations/20260602_add_campaign_soft_delete.sql
```

### 2. Verify the migration
```sql
\d campaigns
-- Should show deleted_at column with type TIMESTAMPTZ

-- Check the index
\d campaigns
-- Should show index: campaigns_deleted_at_idx WHERE deleted_at IS NULL
```

### 3. Start the backend server
```bash
cd backend
npm run dev
```

### 4. Start the frontend server
```bash
cd frontend
npm run dev
```

### 5. Test soft delete as campaign creator
- Log in as a creator user
- Navigate to a campaign you created
- Verify the "Delete campaign" button is visible (campaign must be active with no pending withdrawals)
- Click "Delete campaign"
- Verify the confirmation dialog appears
- Type the campaign title incorrectly and verify the delete button is disabled
- Type the campaign title correctly and verify the delete button becomes enabled
- Click "Delete Campaign"
- Verify the campaign is deleted and you're redirected to the home page
- Verify the deleted campaign no longer appears in the campaign list
- Try to access the deleted campaign URL directly - should return 404

### 6. Test deletion blocked with pending withdrawal
- Create a campaign and fund it
- Request a withdrawal (make it pending)
- Navigate to the campaign page
- Verify the "Delete campaign" button is NOT visible (because there's a pending withdrawal)
- Try to delete via API: `DELETE /api/campaigns/:id` - should return 409 with error message

### 7. Test admin restore endpoint
- Log in as an admin user
- Use API to restore a deleted campaign:
  ```bash
  POST /api/admin/campaigns/:id/restore
  Authorization: Bearer <admin_token>
  ```
- Verify response: `{ restored: true }`
- Verify the campaign is now visible in the campaign list
- Verify you can access the campaign page again

### 8. Test that deleted campaigns are filtered from all endpoints
- Test GET /api/campaigns - deleted campaigns should not appear
- Test GET /api/campaigns/:id - deleted campaigns should return 404
- Test GET /api/campaigns/:id/embed - deleted campaigns should return 404
- Test GET /api/campaigns/:id/backers - deleted campaigns should return 404
- Test GET /api/campaigns/:id/stream - deleted campaigns should return 404
- Test GET /api/campaigns/:id/balance - deleted campaigns should return 404

### 9. Verify data preservation
- After deleting a campaign, query the database:
  ```sql
  SELECT * FROM campaigns WHERE id = '<campaign_id>';
  -- Should show deleted_at is NOT NULL
  
  SELECT * FROM contributions WHERE campaign_id = '<campaign_id>';
  -- Should still show all contributions
  
  SELECT * FROM withdrawal_requests WHERE campaign_id = '<campaign_id>';
  -- Should still show all withdrawal requests
  
  SELECT * FROM stellar_transactions WHERE campaign_id = '<campaign_id>';
  -- Should still show all stellar transactions
  ```

### 10. Test permission checks
- Try to delete a campaign as a non-creator user - should return 404 or 403
- Try to restore a campaign as a non-admin user - should return 403
- Verify only the campaign creator can delete their own campaigns

### 11. Test edge cases
- Try to delete an already deleted campaign - should return 404 "Campaign not found or already deleted"
- Try to delete a non-existent campaign - should return 404
- Try to delete a campaign with status 'funded' - button should not be visible (only visible for 'active')
- Verify the confirmation dialog can be cancelled without deleting

## Impact
- **User Experience**: Campaign creators can now delete campaigns they no longer want, with a safety confirmation
- **Data Integrity**: All contribution and withdrawal history is preserved, allowing for audit trails and recovery
- **Admin Control**: Admins can restore accidentally deleted campaigns
- **Performance**: Partial index on deleted_at ensures queries remain fast
- **Safety**: Confirmation dialog prevents accidental deletions
- **Protection**: Deletion blocked when pending withdrawals exist to prevent financial inconsistencies

## Related Files
- `backend/db/migrations/20260602_add_campaign_soft_delete.sql` - Database migration
- `backend/src/routes/campaigns.js` - Backend routes and queries
- `frontend/src/services/api.js` - API service
- `frontend/src/pages/Campaign.jsx` - Campaign page UI

## Technical Details

### Database Schema Changes
```sql
ALTER TABLE campaigns ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX ON campaigns (deleted_at) WHERE deleted_at IS NULL;
```

### Query Filter Pattern
All public campaign queries now include:
```sql
WHERE deleted_at IS NULL
```

This ensures deleted campaigns are invisible to users while preserving the data.

### Delete Endpoint Logic
1. Check for pending withdrawals
2. If pending withdrawals exist, return 409
3. Update campaigns set deleted_at = NOW() where id = $1 AND creator_id = $2 AND deleted_at IS NULL
4. Return 404 if no rows updated (not found or already deleted)
5. Return { deleted: true } on success

### Restore Endpoint Logic
1. Update campaigns set deleted_at = NULL where id = $1
2. Return { restored: true } on success

### Frontend Confirmation Flow
1. User clicks "Delete campaign" button
2. Confirmation dialog opens
3. User must type exact campaign title
4. Delete button disabled until confirmation matches
5. On confirm, API call to DELETE /api/campaigns/:id
6. On success, redirect to home page
7. On error, display error message in dialog

## Checklist
- [x] Database migration created
- [x] All campaign queries updated to filter deleted_at IS NULL
- [x] DELETE endpoint added with creator-only access
- [x] Pending withdrawal check implemented
- [x] Admin restore endpoint added
- [x] Frontend delete button added
- [x] Confirmation dialog implemented
- [x] Campaign title confirmation required
- [x] Pending withdrawal check in frontend
- [x] API service updated with deleteCampaign function
- [x] Testing instructions provided
