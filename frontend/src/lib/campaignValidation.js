export function emptyMilestone() {
  return { title: '', description: '', release_percentage: '' };
}

export function emptyTier() {
  return {
    title: '',
    description: '',
    min_amount: '',
    limit: '',
    estimated_delivery: '',
    nft_enabled: false,
    nft_metadata_url: '',
    nft_artwork_url: '',
  };
}

export function milestonePercentTotal(milestones) {
  return milestones.reduce(
    (sum, milestone) => sum + (Number(milestone.release_percentage) || 0),
    0
  );
}

export function stepOneError(form) {
  if (!form.title.trim()) return 'Please enter a campaign title.';
  if (!form.target_amount || Number(form.target_amount) <= 0) {
    return 'Enter a fundraising goal greater than zero.';
  }
  return '';
}

export function stepTwoError(form) {
  if (form.deadline) {
    const deadlineDate = new Date(form.deadline);
    const now = new Date();
    if (deadlineDate.getTime() <= now.getTime()) {
      return 'Deadline must be today or in the future (UTC).';
    }
  }
  if (form.min_contribution && Number(form.min_contribution) <= 0) {
    return 'Minimum contribution must be greater than zero.';
  }
  if (form.max_contribution) {
    if (Number(form.max_contribution) <= 0) {
      return 'Maximum contribution must be greater than zero.';
    }
    if (form.min_contribution && Number(form.max_contribution) <= Number(form.min_contribution)) {
      return 'Maximum contribution must be greater than minimum contribution.';
    }
    if (form.target_amount && Number(form.max_contribution) > Number(form.target_amount)) {
      return 'Maximum contribution cannot exceed the target amount.';
    }
  }
  if (form.max_per_user) {
    if (Number(form.max_per_user) <= 0) {
      return 'Per-contributor cap must be greater than zero.';
    }
    if (form.min_contribution && Number(form.max_per_user) <= Number(form.min_contribution)) {
      return 'Per-contributor cap must be greater than minimum contribution.';
    }
  }
  return '';
}

export function milestonesError(form) {
  if (form.milestones.length === 0) return '';
  if (form.milestones.length > 5) return 'Campaigns can define at most 5 milestones.';

  for (let index = 0; index < form.milestones.length; index += 1) {
    const milestone = form.milestones[index];
    if (!milestone.title.trim()) return `Milestone ${index + 1} needs a title.`;
    if (!milestone.description.trim()) return `Milestone ${index + 1} needs a description.`;
    if (!milestone.release_percentage || Number(milestone.release_percentage) <= 0) {
      return `Milestone ${index + 1} needs a release percentage greater than zero.`;
    }
  }

  const total = milestonePercentTotal(form.milestones);
  if (Math.abs(total - 100) > 0.0001) return 'Milestone percentages must sum to exactly 100%.';
  return '';
}

export function tiersError(form, today) {
  if (form.reward_tiers.length === 0) return '';
  if (form.reward_tiers.length > 10) return 'Campaigns can define at most 10 reward tiers.';

  for (let index = 0; index < form.reward_tiers.length; index += 1) {
    const tier = form.reward_tiers[index];
    if (!tier.title.trim()) return `Reward tier ${index + 1} needs a title.`;
    if (!tier.min_amount || Number(tier.min_amount) <= 0) {
      return `Reward tier ${index + 1} needs a minimum amount greater than zero.`;
    }
    if (tier.limit && (Number(tier.limit) <= 0 || !Number.isInteger(Number(tier.limit)))) {
      return `Reward tier ${index + 1} limit must be a positive whole number.`;
    }
    if (tier.estimated_delivery && tier.estimated_delivery < today) {
      return `Reward tier ${index + 1} estimated delivery must be today or in the future.`;
    }
  }
  return '';
}
