import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import FollowCampaignButton from '../../components/FollowCampaignButton';

vi.mock('../../services/api', () => ({
  api: {
    getCampaignFollow: vi.fn(),
    followCampaign: vi.fn(),
    unfollowCampaign: vi.fn(),
    updateCampaignFollow: vi.fn(),
  },
}));

import { api } from '../../services/api';

const NOT_FOLLOWING = {
  following: false,
  notify_updates: true,
  notify_milestones: true,
  notify_funding: true,
  follower_count: 4,
};

const FOLLOWING = { ...NOT_FOLLOWING, following: true, follower_count: 5 };

describe('FollowCampaignButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('follows a campaign and shows the updated follower count', async () => {
    api.getCampaignFollow.mockResolvedValue(NOT_FOLLOWING);
    api.followCampaign.mockResolvedValue(FOLLOWING);

    renderWithProviders(<FollowCampaignButton campaignId="campaign-1" />);

    const button = await screen.findByRole('button', { name: /Follow/i });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(button);

    await waitFor(() => expect(api.followCampaign).toHaveBeenCalledWith('campaign-1'));
    expect(await screen.findByRole('button', { name: /Following \(5\)/i })).toBeInTheDocument();
  });

  it('unfollows a campaign', async () => {
    api.getCampaignFollow.mockResolvedValue(FOLLOWING);
    api.unfollowCampaign.mockResolvedValue(undefined);

    renderWithProviders(<FollowCampaignButton campaignId="campaign-1" />);

    await userEvent.click(await screen.findByRole('button', { name: /Following/i }));

    await waitFor(() => expect(api.unfollowCampaign).toHaveBeenCalledWith('campaign-1'));
    expect(await screen.findByRole('button', { name: /Follow \(4\)/i })).toBeInTheDocument();
  });

  it('saves a notification preference for the followed campaign', async () => {
    api.getCampaignFollow.mockResolvedValue(FOLLOWING);
    api.updateCampaignFollow.mockResolvedValue({ ...FOLLOWING, notify_funding: false });

    renderWithProviders(<FollowCampaignButton campaignId="campaign-1" />);

    await userEvent.click(await screen.findByRole('button', { name: /Notification preferences/i }));
    await userEvent.click(screen.getByLabelText('Funding milestones'));

    await waitFor(() =>
      expect(api.updateCampaignFollow).toHaveBeenCalledWith('campaign-1', {
        notify_funding: false,
      })
    );
    expect(screen.getByLabelText('Funding milestones')).not.toBeChecked();
  });

  it('restores the previous preference when saving fails', async () => {
    api.getCampaignFollow.mockResolvedValue(FOLLOWING);
    api.updateCampaignFollow.mockRejectedValue(new Error('Network error'));

    renderWithProviders(<FollowCampaignButton campaignId="campaign-1" />);

    await userEvent.click(await screen.findByRole('button', { name: /Notification preferences/i }));
    await userEvent.click(screen.getByLabelText('Campaign updates'));

    expect(await screen.findByText('Network error')).toBeInTheDocument();
    expect(screen.getByLabelText('Campaign updates')).toBeChecked();
  });
});
