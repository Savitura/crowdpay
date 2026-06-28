const VALID_ROLES = ['owner', 'manager', 'editor', 'viewer'];

const ROLE_RANK = {
  owner: 4,
  manager: 3,
  editor: 2,
  viewer: 1,
};

function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

function canPostUpdates(role) {
  return role === 'owner' || role === 'manager';
}

function canEditCampaignContent(role) {
  return role === 'owner' || role === 'editor';
}

function canViewAnalytics(role) {
  return role === 'owner' || role === 'manager' || role === 'viewer';
}

function canManageMembers(role) {
  return role === 'owner' || role === 'manager';
}

function canInviteMembers(role) {
  return role === 'owner' || role === 'manager';
}

function canChangeRoles(role) {
  return role === 'owner';
}

function canSubmitMilestones(role) {
  return role === 'owner' || role === 'manager';
}

function canDeleteCampaign(role) {
  return role === 'owner';
}

module.exports = {
  VALID_ROLES,
  ROLE_RANK,
  isValidRole,
  canPostUpdates,
  canEditCampaignContent,
  canViewAnalytics,
  canManageMembers,
  canInviteMembers,
  canChangeRoles,
  canSubmitMilestones,
  canDeleteCampaign,
};
