const CREATOR_KEY = 'cp_onboarding_creator_dismissed';
const CONTRIBUTOR_KEY = 'cp_onboarding_contributor_dismissed';
const CHECKLIST_DISMISSED_KEY = 'cp_creator_checklist_dismissed';

export function isCreatorOnboardingVisible() {
  return localStorage.getItem(CREATOR_KEY) !== '1';
}

export function dismissCreatorOnboarding() {
  localStorage.setItem(CREATOR_KEY, '1');
}

export function isContributorOnboardingVisible() {
  return localStorage.getItem(CONTRIBUTOR_KEY) !== '1';
}

export function dismissContributorOnboarding() {
  localStorage.setItem(CONTRIBUTOR_KEY, '1');
}

export function markJustRegistered() {
  sessionStorage.setItem('cp_just_registered', '1');
}

export function consumeJustRegistered() {
  if (sessionStorage.getItem('cp_just_registered') !== '1') return false;
  sessionStorage.removeItem('cp_just_registered');
  return true;
}

export function isCreatorChecklistDismissed() {
  try {
    return localStorage.getItem(CHECKLIST_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissCreatorChecklist() {
  try {
    localStorage.setItem(CHECKLIST_DISMISSED_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function restoreCreatorChecklist() {
  try {
    localStorage.removeItem(CHECKLIST_DISMISSED_KEY);
  } catch {
    /* ignore */
  }
}

/** Checklist steps for new campaign creators. */
export const CREATOR_CHECKLIST_ITEMS = [
  { id: 'profile', label: 'Complete profile', href: '/profile' },
  { id: 'wallet', label: 'Connect Stellar wallet', href: '/profile' },
  { id: 'kyc', label: 'Complete KYC verification', href: '/profile' },
  { id: 'create', label: 'Create first campaign', href: '/campaigns/new' },
  { id: 'goal', label: 'Set funding goal and deadline', href: '/campaigns/new' },
  { id: 'media', label: 'Add campaign description and media', href: '/campaigns/new' },
  { id: 'launch', label: 'Preview and launch', href: '/campaigns/new' },
];

export function isPublishedCampaign(campaign) {
  const status = (campaign?.status || '').toLowerCase();
  return Boolean(status) && status !== 'draft';
}

export function hasPublishedCampaigns(campaigns = [], stats = null) {
  if ((campaigns || []).some(isPublishedCampaign)) return true;
  if (stats && (Number(stats.active_campaigns) > 0 || Number(stats.funded_campaigns) > 0)) {
    return true;
  }
  return false;
}

function campaignHasMedia(campaign) {
  return Boolean(
    campaign?.cover_image_url ||
      campaign?.image_url ||
      campaign?.cover_url ||
      campaign?.media_url
  );
}

/**
 * Derive checklist completion from account + campaign state (no extra network I/O).
 * Optional `draftForm` is the local campaign draft form from campaignDraft.loadDraft().
 */
export function getCreatorChecklistProgress(user, campaigns = [], draftForm = null) {
  const list = campaigns || [];
  const draft = draftForm || {};

  const profileDone = Boolean(user?.name && String(user.name).trim());
  const walletDone = Boolean(user?.wallet_public_key);
  const kycDone =
    user?.kyc_status === 'verified' ||
    user?.verification_status === 'verified';

  const createDone =
    list.length > 0 ||
    Boolean(draft.title && String(draft.title).trim()) ||
    Boolean(draft.description && String(draft.description).trim());

  const goalDone =
    list.some((c) => Number(c.target_amount) > 0 && Boolean(c.deadline)) ||
    (Number(draft.target_amount) > 0 && Boolean(draft.deadline));

  const mediaDone =
    list.some(
      (c) => Boolean(c.description && String(c.description).trim()) && campaignHasMedia(c)
    ) ||
    (Boolean(draft.description && String(draft.description).trim()) &&
      Boolean(draft.cover_image_url || draft.image_url || draft.media_url));

  const launchDone = list.some(isPublishedCampaign);

  const doneMap = {
    profile: profileDone,
    wallet: walletDone,
    kyc: kycDone,
    create: createDone,
    goal: goalDone,
    media: mediaDone,
    launch: launchDone,
  };

  const items = CREATOR_CHECKLIST_ITEMS.map((item) => ({
    ...item,
    done: Boolean(doneMap[item.id]),
  }));
  const doneCount = items.filter((i) => i.done).length;
  const total = items.length;
  const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  return { items, doneCount, total, percent };
}

export function shouldShowCreatorChecklist({
  user,
  campaigns = [],
  stats = null,
  dismissed = false,
} = {}) {
  if (!user) return false;
  if (user.role !== 'creator' && user.role !== 'admin') return false;
  if (hasPublishedCampaigns(campaigns, stats)) return false;
  if (dismissed) return false;
  return true;
}
