import React from 'react';
import CampaignComments from '../../CampaignComments';

export default function CampaignCommentsTab({ campaignId, campaign }) {
  if (!campaignId) return null;

  return (
    <div style={{ marginTop: '1.5rem', marginBottom: '2rem' }} data-no-print>
      <CampaignComments campaignId={campaignId} campaign={campaign} />
    </div>
  );
}
