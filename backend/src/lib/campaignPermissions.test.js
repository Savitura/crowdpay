const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidRole, canPostUpdates, canEditCampaignContent, canViewAnalytics } = require('../lib/campaignPermissions');

test('role helpers enforce manager vs editor capabilities', () => {
  assert.equal(canPostUpdates('manager'), true);
  assert.equal(canPostUpdates('editor'), false);
  assert.equal(canEditCampaignContent('editor'), true);
  assert.equal(canViewAnalytics('editor'), false);
  assert.equal(canViewAnalytics('viewer'), true);
});

test('isValidRole accepts all team roles', () => {
  for (const role of ['owner', 'manager', 'editor', 'viewer']) {
    assert.equal(isValidRole(role), true);
  }
  assert.equal(isValidRole('admin'), false);
});
