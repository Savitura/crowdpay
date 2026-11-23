export function progressPct(campaign) {
  if (!Number(campaign.target_amount)) return 0;
  return Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100);
}

export function exportCSV(rows, filename) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const csv = [
    keys.join(','),
    ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(',')),
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

export function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
}

export function buildActionItems(campaigns, milestonesByCampaign, lastUpdateByCampaign) {
  const items = [];

  campaigns.forEach((campaign) => {
    if (campaign.status === 'draft') {
      items.push({
        key: `draft-${campaign.id}`,
        priority: 2,
        campaignId: campaign.id,
        title: `"${campaign.title}" is still a draft`,
        detail: 'Publish it so backers can find and support it.',
      });
      return;
    }

    if (campaign.status !== 'active') return;

    const approvedMilestones = (milestonesByCampaign[campaign.id] || []).filter(
      (m) => m.status === 'approved'
    );
    if (approvedMilestones.length > 0) {
      items.push({
        key: `withdraw-${campaign.id}`,
        priority: 0,
        campaignId: campaign.id,
        title: `Funds ready to withdraw for "${campaign.title}"`,
        detail: `${approvedMilestones.length} approved milestone${approvedMilestones.length > 1 ? 's' : ''} awaiting release.`,
      });
    }

    const lastUpdate = lastUpdateByCampaign[campaign.id];
    const campaignAgeDays = daysSince(campaign.created_at) ?? 0;
    const sinceUpdateDays = lastUpdate ? daysSince(lastUpdate.created_at) : campaignAgeDays;
    if (campaignAgeDays >= 7 && (sinceUpdateDays === null || sinceUpdateDays >= 10)) {
      items.push({
        key: `update-${campaign.id}`,
        priority: 1,
        campaignId: campaign.id,
        title: `"${campaign.title}" needs an update`,
        detail: lastUpdate
          ? `Last update was ${sinceUpdateDays} days ago. Backers stay engaged when they hear from you.`
          : 'No updates posted yet. Share your progress with backers.',
      });
    }

    const pct = progressPct(campaign);
    const deadlineDays = daysUntil(campaign.deadline);
    if (deadlineDays !== null && deadlineDays >= 0 && deadlineDays <= 7 && pct < 75) {
      items.push({
        key: `deadline-${campaign.id}`,
        priority: 1,
        campaignId: campaign.id,
        title: `"${campaign.title}" is running out of time`,
        detail: `${deadlineDays} day${deadlineDays === 1 ? '' : 's'} left at ${pct.toFixed(0)}% funded. Consider sharing it again.`,
      });
    }

    if (campaign.is_hidden) {
      items.push({
        key: `hidden-${campaign.id}`,
        priority: 2,
        campaignId: campaign.id,
        title: `"${campaign.title}" is hidden from discovery`,
        detail: 'Make it visible again if you want new backers to find it.',
      });
    }
  });

  return items.sort((a, b) => a.priority - b.priority);
}
