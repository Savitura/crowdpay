import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import Home from '../../pages/Home';
import { renderWithProviders } from '../renderWithProviders';
import { api } from '../../services/api';

const apiMocks = vi.hoisted(() => ({
  getCampaignCategories: vi.fn().mockResolvedValue([]),
  getFeaturedCampaigns: vi.fn().mockResolvedValue([]),
  getCampaignFacets: vi.fn().mockResolvedValue({ categories: [], assets: [], countries: [], funding: { min: 0, max: 0 }, verified_creators: 0 }),
  getCampaigns: vi.fn().mockResolvedValue({ campaigns: [{ id: '1', title: 'Test campaign', status: 'active', target_amount: '100', asset_type: 'USDC' }], total: 1 }),
  getCampaign: vi.fn().mockResolvedValue({}),
  getRecommendedCampaigns: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: null, ready: true }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('Home page', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the hero heading and call to action', async () => {
    renderWithProviders(<Home />);

    expect(await screen.findByRole('heading', { name: /Explore campaigns/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create account/i })).toBeInTheDocument();
  });

  it('shows a skeleton while campaigns are loading', async () => {
    apiMocks.getCampaigns.mockImplementation(() => new Promise(() => {}));

    const { container } = renderWithProviders(<Home />);

    await waitFor(() => {
      expect(container.querySelector('.skeleton--card')).toBeInTheDocument();
    });
  });

  it('renders an error message when campaigns fail to load', async () => {
    apiMocks.getCampaigns.mockRejectedValue(new Error('Unable to load campaigns'));

    renderWithProviders(<Home />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load campaigns');
  });
});

describe('api exports for Home page', () => {
  it('exports all required campaign methods', () => {
    expect(typeof api.getFeaturedCampaigns).toBe('function');
    expect(typeof api.getCampaigns).toBe('function');
    expect(typeof api.getCampaignCategories).toBe('function');
    expect(typeof api.getCampaignFacets).toBe('function');
    expect(typeof api.getRecommendedCampaigns).toBe('function');
  });
});
