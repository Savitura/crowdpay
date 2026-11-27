import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Discover from '../../pages/Discover';
import { renderWithProviders } from '../renderWithProviders';

const mocks = vi.hoisted(() => ({
  authState: { user: null },
  api: {
    getTrendingCampaigns: vi.fn(),
    getRecommendedCampaigns: vi.fn(),
    getCampaigns: vi.fn(),
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => mocks.authState,
}));

vi.mock('../../services/api', () => ({ api: mocks.api }));

vi.mock('../../components/CampaignCard', () => ({
  default: ({ campaign }) => <div data-testid="campaign-card">{campaign.title}</div>,
}));

const campaign = (id, title) => ({
  id,
  title,
  status: 'active',
  asset_type: 'USDC',
  raised_amount: '50',
  target_amount: '100',
});

describe('Discover page', () => {
  beforeEach(() => {
    mocks.authState.user = null;
    mocks.api.getTrendingCampaigns.mockReset().mockResolvedValue({
      campaigns: [campaign('trending', 'Trending campaign')],
    });
    mocks.api.getRecommendedCampaigns.mockReset().mockResolvedValue({
      campaigns: [campaign('recommended', 'Recommended campaign')],
    });
    mocks.api.getCampaigns.mockReset().mockResolvedValue({
      campaigns: [campaign('all', 'All campaign')],
    });
  });

  it('shows loading states and then the trending and all campaign results', async () => {
    renderWithProviders(<Discover />);

    expect(screen.getByText(/Loading trending campaigns/)).toBeInTheDocument();
    expect(screen.getByText(/Loading campaigns/)).toBeInTheDocument();

    expect(await screen.findByText('Trending campaign')).toBeInTheDocument();
    expect(await screen.findByText('All campaign')).toBeInTheDocument();
    expect(screen.getAllByTestId('campaign-card')).toHaveLength(2);
    expect(mocks.api.getTrendingCampaigns).toHaveBeenCalledWith({ limit: 10 });
    expect(mocks.api.getCampaigns).toHaveBeenCalledWith({ limit: 24, sort: 'newest' });
  });

  it('switches between the campaign feed filters for authenticated users', async () => {
    mocks.authState.user = { id: 'user-1' };
    renderWithProviders(<Discover />);

    await screen.findByText('All campaign');
    await userEvent.click(screen.getByRole('button', { name: 'For You' }));

    expect(await screen.findByText('Recommended campaign')).toBeInTheDocument();
    expect(screen.queryByText('All campaign')).not.toBeInTheDocument();
    expect(mocks.api.getRecommendedCampaigns).toHaveBeenCalledWith({ limit: 12 });

    await userEvent.click(screen.getByRole('button', { name: 'All campaigns' }));

    expect(await screen.findByText('All campaign')).toBeInTheDocument();
    expect(screen.queryByText('Recommended campaign')).not.toBeInTheDocument();
  });

  it('does not offer the personalised feed to anonymous users', async () => {
    renderWithProviders(<Discover />);

    await screen.findByText('All campaign');
    expect(screen.queryByRole('button', { name: 'For You' })).not.toBeInTheDocument();
  });

  it('shows the personalised empty state when recommendations fail', async () => {
    mocks.authState.user = { id: 'user-1' };
    mocks.api.getRecommendedCampaigns.mockRejectedValueOnce(new Error('Recommendations failed'));

    renderWithProviders(<Discover />);
    await screen.findByText('All campaign');
    await userEvent.click(screen.getByRole('button', { name: 'For You' }));

    expect(await screen.findByText(/Fund a few campaigns/)).toBeInTheDocument();
  });

  it('hides the trending section when trending campaigns fail to load', async () => {
    mocks.api.getTrendingCampaigns.mockRejectedValueOnce(new Error('Trending failed'));

    renderWithProviders(<Discover />);

    expect(await screen.findByText('All campaign')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Trending now/)).not.toBeInTheDocument();
    });
  });
});
