import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import CreatorProfile from '../../pages/CreatorProfile';
import { renderWithProviders } from '../renderWithProviders';

const CREATOR_ID = 'creator-42';

const apiMocks = vi.hoisted(() => ({
  getCreatorProfile: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

const PROFILE = {
  name: 'Ada Lovelace',
  wallet_public_key: 'GADACREATORPUBLICKEY',
  member_since: '2022-05-10T00:00:00.000Z',
  stats: {
    total_campaigns: 2,
    total_raised: 12500,
    total_backers: 140,
    follower_count: 32,
  },
  campaigns: [
    {
      id: 'campaign-1',
      title: 'Solar Wells',
      status: 'active',
      raised_amount: '7500',
      target_amount: '10000',
      asset_type: 'USDC',
    },
    {
      id: 'campaign-2',
      title: 'Clean Ocean',
      status: 'completed',
      raised_amount: '5000',
      target_amount: '10000',
      asset_type: 'XLM',
    },
  ],
};

function renderCreatorProfile() {
  return renderWithProviders(
    <Routes>
      <Route path="/creators/:id" element={<CreatorProfile />} />
    </Routes>,
    { route: `/creators/${CREATOR_ID}` }
  );
}

describe('CreatorProfile page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the profile for the route id and then renders stats and campaigns', async () => {
    let resolveProfile;
    apiMocks.getCreatorProfile.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      })
    );

    renderCreatorProfile();

    expect(screen.getByText('Loading profile…')).toBeInTheDocument();
    expect(apiMocks.getCreatorProfile).toHaveBeenCalledWith(CREATOR_ID);

    await act(async () => {
      resolveProfile(PROFILE);
    });

    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('Member since 2022')).toBeInTheDocument();
    expect(screen.getByText('12,500')).toBeInTheDocument();
    expect(screen.getByText('140')).toBeInTheDocument();
    expect(screen.getByText('32')).toBeInTheDocument();

    const solarWells = screen.getByRole('link', { name: /Solar Wells/i });
    expect(solarWells).toHaveAttribute('href', '/campaigns/campaign-1');
    expect(screen.getByText('7,500 USDC raised')).toBeInTheDocument();
    expect(screen.getByText('75% of goal')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Clean Ocean/i })).toHaveAttribute(
      'href',
      '/campaigns/campaign-2'
    );
    expect(screen.getByText('50% of goal')).toBeInTheDocument();
  });

  it('renders an empty state when the creator has no public campaigns', async () => {
    apiMocks.getCreatorProfile.mockResolvedValue({ ...PROFILE, campaigns: [] });

    renderCreatorProfile();

    expect(await screen.findByText('No public campaigns yet.')).toBeInTheDocument();
  });

  it('shows not found when the profile request returns no creator', async () => {
    apiMocks.getCreatorProfile.mockResolvedValue(null);

    renderCreatorProfile();

    expect(await screen.findByText('Creator not found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Campaigns/i })).not.toBeInTheDocument();
  });

  it('surfaces the not-found error message from the API', async () => {
    apiMocks.getCreatorProfile.mockRejectedValue(new Error('Creator not found'));

    renderCreatorProfile();

    expect(await screen.findByText('Creator not found')).toBeInTheDocument();
  });
});
