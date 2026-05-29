# Admin Moderation Testing Guide

## Quick Start

### 1. Setup Test Admin Account

```sql
-- Create admin user
INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, is_admin)
VALUES ('admin@test.local', 'hash', 'Test Admin', 'GADMINPUBKEY123456789', 'encrypted_secret', true);

-- Or promote existing user
UPDATE users SET is_admin = true WHERE email = 'your-email@example.com';
```

### 2. Login and Get Admin Token

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.local","password":"password"}'
```

Response contains JWT token - save as `$ADMIN_TOKEN`

### 3. Run Admin Operations

## Test Scenarios

### Scenario 1: Suspend a Campaign

```bash
# Get list of campaigns
curl http://localhost:3000/api/admin/campaigns \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Note campaign ID, then suspend it
CAMPAIGN_ID="550e8400-e29b-41d4-a716-446655440000"

curl -X PATCH http://localhost:3000/api/admin/campaigns/$CAMPAIGN_ID/suspend \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Violates terms of service"}'

# Expected: 200 OK with campaign status = "suspended"
```

### Scenario 2: Verify Suspended Campaign Behavior

```bash
# Try to view campaign (should work with notice)
curl http://localhost:3000/api/campaigns/$CAMPAIGN_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: 200 OK with suspended_notice field

# Try public listing (should NOT include suspended campaign)
curl http://localhost:3000/api/campaigns

# Note: suspended campaign won't appear in results

# Try to contribute to suspended campaign (should fail)
curl -X POST http://localhost:3000/api/contributions/prepare \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "campaignId":"'$CAMPAIGN_ID'",
    "senderPublicKey":"GUSERPUBKEY123456789",
    "amount":"100",
    "asset":"XLM"
  }'
# Expected: 400 Bad Request - campaign not found/not active
```

### Scenario 3: Restore Campaign

```bash
curl -X PATCH http://localhost:3000/api/admin/campaigns/$CAMPAIGN_ID/restore \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Expected: 200 OK with campaign status = "active"

# Verify it reappears in public listing
curl http://localhost:3000/api/campaigns | grep -i $CAMPAIGN_ID
```

### Scenario 4: Delete Campaign

```bash
curl -X DELETE http://localhost:3000/api/admin/campaigns/$CAMPAIGN_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Fraudulent campaign - creator ban pending"}'

# Expected: 200 OK with deleted_at timestamp

# Try to access deleted campaign
curl http://localhost:3000/api/campaigns/$CAMPAIGN_ID
# Expected: 404 Not Found
```

### Scenario 5: Ban User

```bash
# Get list of users
curl http://localhost:3000/api/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN"

USER_ID="660e8400-e29b-41d4-a716-446655440000"

curl -X PATCH http://localhost:3000/api/admin/users/$USER_ID/ban \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Abusive communication in disputes"}'

# Expected: 200 OK with is_banned = true
```

### Scenario 6: View Audit Log

```bash
curl "http://localhost:3000/api/admin/audit-log?limit=20&offset=0" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Expected: JSON array of admin actions with:
# - admin_user_id
# - action_type (suspend, restore, delete, ban, unban, etc.)
# - target_type (campaign or user)
# - target_id
# - details (JSON object with reason, etc.)
# - created_at (ISO timestamp)
```

### Scenario 7: Admin Stats

```bash
curl http://localhost:3000/api/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Expected response:
# {
#   "total_users": 45,
#   "banned_users": 2,
#   "campaign_status": [
#     {"status": "active", "count": 12},
#     {"status": "suspended", "count": 1},
#     {"status": "completed", "count": 5}
#   ],
#   "deleted_campaigns": 3,
#   "total_raised": 15000.5,
#   "total_contributions": 234
# }
```

## Permission Tests

### Should Fail: Non-Admin Access

```bash
# Login as regular user
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"regular@test.local","password":"password"}'
# Save token as $USER_TOKEN

# Try to access admin route
curl http://localhost:3000/api/admin/campaigns \
  -H "Authorization: Bearer $USER_TOKEN"

# Expected: 403 Forbidden
# {
#   "error": "Requires admin privileges"
# }
```

### Should Fail: Unauthenticated Access

```bash
curl http://localhost:3000/api/admin/campaigns
# Expected: 401 Unauthorized
```

## Frontend Testing

### 1. Navigate to Admin Dashboard

```
http://localhost:5173/admin
```

If you're not logged in as admin:
- You'll be redirected to home page

If you're logged in as admin:
- Dashboard loads with tabs: Campaigns, Users, Disputes, Milestones, Audit

### 2. Test Campaign Suspension UI

1. Go to "Campaigns" tab
2. Find an active campaign
3. Click "Suspend" button
4. Enter reason in prompt
5. Verify campaign row highlights red
6. Verify "Restore" button appears
7. Check "Audit" tab - should show new suspend action

### 3. Test User Banning UI

1. Go to "Users" tab
2. Find active user
3. Click "Ban" button
4. Enter reason in prompt
5. Verify user row highlights red
6. Verify "Unban" button appears
7. Check "Audit" tab - should show new ban action

### 4. Test Audit Log

1. Go to "Audit" tab
2. Verify all previous actions listed
3. Verify pagination works (limit/offset)
4. Verify color coding (red for ban/suspend/delete, blue for other actions)

## Database Verification

### Verify Audit Table Created

```sql
SELECT * FROM admin_actions LIMIT 5;

-- Should show columns:
-- id, admin_user_id, action_type, target_type, target_id, details, created_at
```

### Check Campaign Status

```sql
SELECT id, title, status, deleted_at FROM campaigns WHERE status = 'suspended';
```

### Check Banned Users

```sql
SELECT id, email, is_banned FROM users WHERE is_banned = true;
```

### View Specific Admin Action

```sql
SELECT 
  a.id,
  u.email as admin,
  a.action_type,
  a.target_type,
  a.target_id,
  a.details,
  a.created_at
FROM admin_actions a
JOIN users u ON a.admin_user_id = u.id
ORDER BY a.created_at DESC
LIMIT 10;
```

## Troubleshooting

### Issue: Admin Dashboard returns 403

**Solution**: Ensure user has `is_admin = true` in database
```sql
SELECT is_admin FROM users WHERE email = 'your@email.com';
UPDATE users SET is_admin = true WHERE email = 'your@email.com';
```

### Issue: Suspended campaigns still appear in listing

**Solution**: Check that campaigns route filters by `status = 'active'` AND `deleted_at IS NULL`
- Verify migration ran: `SELECT * FROM information_schema.columns WHERE table_name='campaigns' AND column_name='deleted_at'`

### Issue: Audit log is empty

**Solution**: 
- Verify admin_actions table exists: `SELECT COUNT(*) FROM admin_actions;`
- Check that middleware is loading is_admin flag: Verify JWT contains is_admin or DB query succeeds

### Issue: Can still contribute to suspended campaign

**Solution**: Verify contributions route uses `loadActiveCampaign()` which checks status = 'active'
- Check that campaign status is actually 'suspended': `SELECT status FROM campaigns WHERE id = 'campaign-id';`

## Performance Notes

- Audit log queries should be indexed (they are - see migration)
- Admin stats might slow with many campaigns - consider pagination/filtering
- Consider adding admin_actions.action_type index if filtering by action becomes common

## Next Steps

After testing, consider:

1. **Email Notifications**: Notify creators when campaigns are suspended
2. **Batch Operations**: Support suspending multiple campaigns
3. **Appeals Workflow**: Let creators appeal suspensions
4. **Automated Triggers**: Suspend campaigns with many disputes
5. **Temporary Bans**: Add unban_at timestamp for time-limited bans
6. **Admin Tiers**: Different permission levels (view-only, moderator, super-admin)
