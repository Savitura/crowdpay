import { describe, it, expect } from 'vitest';
import {
  emptyMilestone,
  emptyTier,
  milestonePercentTotal,
  stepOneError,
  stepTwoError,
  milestonesError,
  tiersError,
} from './campaignValidation';

const baseForm = () => ({
  title: 'Clean water',
  target_amount: '1000',
  deadline: '',
  min_contribution: '',
  max_contribution: '',
  max_per_user: '',
  milestones: [],
  reward_tiers: [],
});

describe('campaign validation schemas', () => {
  it('builds empty milestone and tier records', () => {
    expect(emptyMilestone()).toEqual({ title: '', description: '', release_percentage: '' });
    expect(emptyTier()).toMatchObject({ title: '', nft_enabled: false });
  });

  it('sums milestone percentages', () => {
    expect(milestonePercentTotal([{ release_percentage: '40' }, { release_percentage: 60 }])).toBe(
      100
    );
    expect(milestonePercentTotal([])).toBe(0);
  });

  it('validates step one', () => {
    expect(stepOneError(baseForm())).toBe('');
    expect(stepOneError({ ...baseForm(), title: '  ' })).toBe('Please enter a campaign title.');
    expect(stepOneError({ ...baseForm(), target_amount: '0' })).toBe(
      'Enter a fundraising goal greater than zero.'
    );
  });

  it('validates step two contribution limits', () => {
    expect(stepTwoError(baseForm())).toBe('');
    expect(stepTwoError({ ...baseForm(), min_contribution: '0' })).toBe(
      'Minimum contribution must be greater than zero.'
    );
    expect(stepTwoError({ ...baseForm(), min_contribution: '10', max_contribution: '10' })).toBe(
      'Maximum contribution must be greater than minimum contribution.'
    );
    expect(stepTwoError({ ...baseForm(), max_contribution: '2000' })).toBe(
      'Maximum contribution cannot exceed the target amount.'
    );
    expect(stepTwoError({ ...baseForm(), max_per_user: '-1' })).toBe(
      'Per-contributor cap must be greater than zero.'
    );
  });

  it('validates milestones', () => {
    expect(milestonesError(baseForm())).toBe('');
    expect(
      milestonesError({
        ...baseForm(),
        milestones: [{ title: 'a', description: 'b', release_percentage: '50' }],
      })
    ).toBe('Milestone percentages must sum to exactly 100%.');
    expect(
      milestonesError({
        ...baseForm(),
        milestones: [{ title: 'a', description: 'b', release_percentage: '100' }],
      })
    ).toBe('');
  });

  it('validates reward tiers against today', () => {
    const today = '2026-01-01';
    expect(tiersError(baseForm(), today)).toBe('');
    expect(
      tiersError(
        {
          ...baseForm(),
          reward_tiers: [{ ...emptyTier(), min_amount: '5' }],
        },
        today
      )
    ).toBe('Reward tier 1 needs a title.');
    expect(
      tiersError(
        {
          ...baseForm(),
          reward_tiers: [{ ...emptyTier(), title: 'Shirt', min_amount: '0' }],
        },
        today
      )
    ).toBe('Reward tier 1 needs a minimum amount greater than zero.');
    expect(
      tiersError(
        {
          ...baseForm(),
          reward_tiers: [
            { ...emptyTier(), title: 'Shirt', min_amount: '5', estimated_delivery: '2025-12-31' },
          ],
        },
        today
      )
    ).toBe('Reward tier 1 estimated delivery must be today or in the future.');
  });
});
