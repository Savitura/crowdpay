import { describe, it, expect, beforeEach } from 'vitest';
import {
  CREATOR_CHECKLIST_ITEMS,
  dismissCreatorChecklist,
  getCreatorChecklistProgress,
  hasPublishedCampaigns,
  isCreatorChecklistDismissed,
  restoreCreatorChecklist,
  shouldShowCreatorChecklist,
} from '../lib/onboarding';

describe('creator onboarding checklist', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('exposes the seven setup steps from the issue brief', () => {
    expect(CREATOR_CHECKLIST_ITEMS).toHaveLength(7);
    expect(CREATOR_CHECKLIST_ITEMS.map((i) => i.id)).toEqual([
      'profile',
      'wallet',
      'kyc',
      'create',
      'goal',
      'media',
      'launch',
    ]);
  });

  it('computes progress from account and campaign state', () => {
    const user = {
      name: 'Ada',
      wallet_public_key: 'GABC',
      kyc_status: 'verified',
      role: 'creator',
    };
    const campaigns = [
      {
        status: 'draft',
        target_amount: '500',
        deadline: '2030-01-01',
        description: 'A full campaign story',
        cover_image_url: 'https://example.com/c.jpg',
      },
    ];
    const { items, percent, doneCount } = getCreatorChecklistProgress(user, campaigns);
    expect(items.find((i) => i.id === 'profile').done).toBe(true);
    expect(items.find((i) => i.id === 'wallet').done).toBe(true);
    expect(items.find((i) => i.id === 'kyc').done).toBe(true);
    expect(items.find((i) => i.id === 'create').done).toBe(true);
    expect(items.find((i) => i.id === 'goal').done).toBe(true);
    expect(items.find((i) => i.id === 'media').done).toBe(true);
    expect(items.find((i) => i.id === 'launch').done).toBe(false);
    expect(doneCount).toBe(6);
    expect(percent).toBe(86);
  });

  it('hides the checklist once a campaign is published', () => {
    const user = { role: 'creator', name: 'Ada' };
    expect(
      shouldShowCreatorChecklist({
        user,
        campaigns: [{ status: 'active' }],
        dismissed: false,
      })
    ).toBe(false);
    expect(hasPublishedCampaigns([], { active_campaigns: 1 })).toBe(true);
  });

  it('can be dismissed and restored from settings', () => {
    expect(isCreatorChecklistDismissed()).toBe(false);
    dismissCreatorChecklist();
    expect(isCreatorChecklistDismissed()).toBe(true);
    expect(
      shouldShowCreatorChecklist({
        user: { role: 'creator' },
        campaigns: [],
        dismissed: true,
      })
    ).toBe(false);
    restoreCreatorChecklist();
    expect(isCreatorChecklistDismissed()).toBe(false);
  });
});
