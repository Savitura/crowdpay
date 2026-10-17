const VALID_ROLES = ['owner', 'manager', 'editor', 'finance', 'viewer'];

const ROLE_RANK = {
  owner: 5,
  manager: 4,
  editor: 3,
  finance: 2,
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
  return role === 'owner' || role === 'manager' || role === 'finance' || role === 'viewer';
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

/**
 * Whether an actor with `actorRole` may grant `targetRole` to a member.
 * Only owners may grant the `owner` role — this prevents a manager from
 * escalating privileges by inviting a brand-new owner. Managers may still
 * invite managers, editors, and viewers.
 */
function canAssignRole(actorRole, targetRole) {
  if (!isValidRole(targetRole)) return false;
  if (targetRole === 'owner') return actorRole === 'owner';
  return canInviteMembers(actorRole);
}

function canSubmitMilestones(role) {
  return role === 'owner' || role === 'manager';
}

function canDeleteCampaign(role) {
  return role === 'owner';
}

/**
 * Finance collaborators (and managers/owners) may initiate and review payouts,
 * but they cannot redirect where funds go.
 */
function canManagePayouts(role) {
  return role === 'owner' || role === 'manager' || role === 'finance';
}

/**
 * Changing the payout destination is owner-only and requires explicit owner
 * confirmation, so a compromised finance/manager session cannot redirect funds.
 */
function canChangePayoutDestination(role) {
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
  canAssignRole,
  canSubmitMilestones,
  canDeleteCampaign,
  canManagePayouts,
  canChangePayoutDestination,
};
