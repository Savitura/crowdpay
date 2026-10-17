const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidRole,
  canPostUpdates,
  canEditCampaignContent,
  canViewAnalytics,
  canAssignRole,
  canManagePayouts,
  canChangePayoutDestination,
} = require('../lib/campaignPermissions');

test('role helpers enforce manager vs editor capabilities', () => {
  assert.equal(canPostUpdates('manager'), true);
  assert.equal(canPostUpdates('editor'), false);
  assert.equal(canEditCampaignContent('editor'), true);
  assert.equal(canViewAnalytics('editor'), false);
  assert.equal(canViewAnalytics('viewer'), true);
});

test('isValidRole accepts all team roles', () => {
  for (const role of ['owner', 'manager', 'editor', 'finance', 'viewer']) {
    assert.equal(isValidRole(role), true);
  }
  assert.equal(isValidRole('admin'), false);
});

test('finance role views analytics and manages payouts but cannot edit content or redirect funds', () => {
  assert.equal(canViewAnalytics('finance'), true);
  assert.equal(canManagePayouts('finance'), true);
  assert.equal(canEditCampaignContent('finance'), false);
  assert.equal(canPostUpdates('finance'), false);
  assert.equal(canChangePayoutDestination('finance'), false);

  assert.equal(canManagePayouts('owner'), true);
  assert.equal(canManagePayouts('manager'), true);
  assert.equal(canManagePayouts('editor'), false);
  assert.equal(canManagePayouts('viewer'), false);

  // Redirecting the payout destination requires explicit owner confirmation.
  assert.equal(canChangePayoutDestination('owner'), true);
  assert.equal(canChangePayoutDestination('manager'), false);
  assert.equal(canChangePayoutDestination('editor'), false);
});

test('canAssignRole prevents non-owners from granting the owner role', () => {
  // Only owners may grant owner.
  assert.equal(canAssignRole('owner', 'owner'), true);
  assert.equal(canAssignRole('manager', 'owner'), false);
  assert.equal(canAssignRole('editor', 'owner'), false);
  assert.equal(canAssignRole('viewer', 'owner'), false);

  // Managers may still invite managers, editors, and viewers.
  assert.equal(canAssignRole('manager', 'manager'), true);
  assert.equal(canAssignRole('manager', 'editor'), true);
  assert.equal(canAssignRole('manager', 'viewer'), true);
  assert.equal(canAssignRole('manager', 'finance'), true);

  // Editors/viewers cannot invite at all.
  assert.equal(canAssignRole('editor', 'viewer'), false);
  assert.equal(canAssignRole('viewer', 'viewer'), false);

  // Invalid target roles are rejected.
  assert.equal(canAssignRole('owner', 'admin'), false);
});
