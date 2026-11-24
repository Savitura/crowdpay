import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import FollowedCampaigns from './FollowedCampaigns';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getFollowedCampaigns: vi.fn(),
    updateCampaignFollow: vi.fn(),
    unfollowCampaign: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
}));

describe('FollowedCampaigns Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    api.getFollowedCampaigns.mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );
    expect(screen.getByText(/Loading followed campaigns/i)).toBeInTheDocument();
  });

  it('renders empty state when user follows no campaigns', async () => {
    api.getFollowedCampaigns.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByText(/You are not following any campaigns yet/i)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Browse campaigns/i)).toBeInTheDocument();
  });

  it('renders API error message when loading followed campaigns fails', async () => {
    api.getFollowedCampaigns.mockRejectedValue(new Error('Failed to load campaigns'));
    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to load campaigns')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/You are not following any campaigns yet/i)
    ).toBeInTheDocument();
  });

  it('renders followed campaigns list', async () => {
    const mockCampaigns = [
      {
        id: 'c1',
        title: 'Solar Power for Schools',
        status: 'active',
        raised_amount: 1000,
        target_amount: 5000,
        asset_type: 'USDC',
        notify_updates: true,
        notify_milestones: false,
        notify_funding: true,
      },
    ];
    api.getFollowedCampaigns.mockResolvedValue(mockCampaigns);

    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Power for Schools')).toBeInTheDocument();
    });
  });

  it('handles unfollow action successfully', async () => {
    const mockCampaigns = [
      {
        id: 'c1',
        title: 'Solar Power for Schools',
        status: 'active',
        raised_amount: 1000,
        target_amount: 5000,
        asset_type: 'USDC',
      },
    ];
    api.getFollowedCampaigns.mockResolvedValue(mockCampaigns);
    api.unfollowCampaign.mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Power for Schools')).toBeInTheDocument();
    });

    const unfollowButton = screen.getByRole('button', { name: /unfollow/i });
    fireEvent.click(unfollowButton);

    expect(api.unfollowCampaign).toHaveBeenCalledWith('c1');

    await waitFor(() => {
      expect(screen.queryByText('Solar Power for Schools')).not.toBeInTheDocument();
    });
    expect(
      screen.getByText(/You are not following any campaigns yet/i)
    ).toBeInTheDocument();
  });

  it('handles unfollow API error and restores campaign item', async () => {
    const mockCampaigns = [
      {
        id: 'c1',
        title: 'Solar Power for Schools',
        status: 'active',
        raised_amount: 1000,
        target_amount: 5000,
        asset_type: 'USDC',
      },
    ];
    api.getFollowedCampaigns.mockResolvedValue(mockCampaigns);
    api.unfollowCampaign.mockRejectedValue(new Error('Network error on unfollow'));

    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Power for Schools')).toBeInTheDocument();
    });

    const unfollowButton = screen.getByRole('button', { name: /unfollow/i });
    fireEvent.click(unfollowButton);

    await waitFor(() => {
      expect(screen.getByText('Network error on unfollow')).toBeInTheDocument();
    });
    expect(screen.getByText('Solar Power for Schools')).toBeInTheDocument();
  });

  it('handles preference toggle action and error', async () => {
    const mockCampaigns = [
      {
        id: 'c1',
        title: 'Solar Power for Schools',
        status: 'active',
        raised_amount: 1000,
        target_amount: 5000,
        asset_type: 'USDC',
        notify_updates: true,
      },
    ];
    api.getFollowedCampaigns.mockResolvedValue(mockCampaigns);
    api.updateCampaignFollow.mockRejectedValue(new Error('Could not save preference'));

    render(
      <MemoryRouter>
        <FollowedCampaigns />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Power for Schools')).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(screen.getByText('Could not save preference')).toBeInTheDocument();
    });
  });
});
