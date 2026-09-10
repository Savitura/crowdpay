import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import Landing from '../../pages/Landing';
import { renderWithProviders } from '../renderWithProviders';
import { api } from '../../services/api';

const apiMocks = vi.hoisted(() => ({
  getFeaturedCampaigns: vi.fn().mockResolvedValue([]),
  getCampaigns: vi.fn().mockResolvedValue({ campaigns: [], total: 0 }),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: null, ready: true }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('Landing page', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the landing heading and main call to action', async () => {
    renderWithProviders(<Landing />);

    expect(await screen.findByRole('heading', { name: /Support with Confidence/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Explore Support Spaces/i })).toBeInTheDocument();
  });

  it('calls getFeaturedCampaigns on mount', async () => {
    renderWithProviders(<Landing />);

    await screen.findByRole('heading', { name: /Support with Confidence/i });
    expect(apiMocks.getFeaturedCampaigns).toHaveBeenCalled();
  });
});

describe('api exports', () => {
  it('exports getFeaturedCampaigns and getCampaigns methods', () => {
    expect(typeof api.getFeaturedCampaigns).toBe('function');
    expect(typeof api.getCampaigns).toBe('function');
  });
});
