const STORAGE_KEY = 'crowdpay:recently_viewed_campaigns';
const MAX_ENTRIES = 12;

function readIds() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentlyViewed(campaignId) {
  if (!campaignId) return;
  try {
    const ids = readIds().filter((id) => id !== campaignId);
    ids.unshift(campaignId);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_ENTRIES)));
  } catch {
    // storage unavailable (private browsing, etc.) — skip silently
  }
}

export function getRecentlyViewedIds(limit = MAX_ENTRIES) {
  return readIds().slice(0, limit);
}
