import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRecentlyViewed, getRecentlyViewedIds } from '../../lib/recentlyViewed';

const STORAGE_KEY = 'crowdpay:recently_viewed_campaigns';

describe('recentlyViewed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty list when there is no history', () => {
    expect(getRecentlyViewedIds()).toEqual([]);
  });

  it('puts the latest campaign first and moves a viewed campaign to the front', () => {
    addRecentlyViewed('campaign-1');
    addRecentlyViewed('campaign-2');
    addRecentlyViewed('campaign-1');

    expect(getRecentlyViewedIds()).toEqual(['campaign-1', 'campaign-2']);
  });

  it('keeps only the 12 most recently viewed campaigns', () => {
    for (let id = 1; id <= 15; id += 1) {
      addRecentlyViewed(`campaign-${id}`);
    }

    expect(getRecentlyViewedIds()).toHaveLength(12);
    expect(getRecentlyViewedIds()).toEqual([
      'campaign-15',
      'campaign-14',
      'campaign-13',
      'campaign-12',
      'campaign-11',
      'campaign-10',
      'campaign-9',
      'campaign-8',
      'campaign-7',
      'campaign-6',
      'campaign-5',
      'campaign-4',
    ]);
  });

  it('limits returned IDs to the requested count', () => {
    addRecentlyViewed('campaign-1');
    addRecentlyViewed('campaign-2');
    addRecentlyViewed('campaign-3');

    expect(getRecentlyViewedIds(2)).toEqual(['campaign-3', 'campaign-2']);
  });

  it('ignores empty campaign IDs', () => {
    addRecentlyViewed('');
    addRecentlyViewed(null);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it.each(['not json', JSON.stringify({ campaign: 'campaign-1' })])(
    'returns an empty history for invalid stored data: %s',
    (value) => {
      window.localStorage.setItem(STORAGE_KEY, value);

      expect(getRecentlyViewedIds()).toEqual([]);
    }
  );

  it('returns an empty history when storage reads fail', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    expect(getRecentlyViewedIds()).toEqual([]);
  });

  it('does not throw when storage writes fail', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    expect(() => addRecentlyViewed('campaign-1')).not.toThrow();
  });
});
