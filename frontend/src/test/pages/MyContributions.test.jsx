import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import MyContributions from '../../pages/MyContributions';
import { renderWithProviders } from '../renderWithProviders';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user1' }, token: 'token', ready: true }),
}));

const apiMocks = vi.hoisted(() => ({
  getMyContributions: vi.fn(),
  getContributorDashboard: vi.fn().mockResolvedValue({
    stats: {
      total_contributed: 0,
      campaigns_backed: 0,
      active_campaigns_backed: 0,
      campaigns_completed: 0,
      avg_contribution: 0,
      total_refunded: 0,
      badges: [],
    },
    campaigns: [],
  }),
  getFavorites: vi.fn().mockResolvedValue([]),
  exportContributionsCsv: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('MyContributions page', () => {
  it('renders ContributorDashboard as the sole data source', async () => {
    renderWithProviders(<MyContributions />);

    expect(await screen.findByRole('heading', { name: /My Contributions/i })).toBeInTheDocument();
    expect(await screen.findByText(/You have not backed any campaigns yet/i)).toBeInTheDocument();
    expect(apiMocks.getMyContributions).not.toHaveBeenCalled();
    expect(apiMocks.getContributorDashboard).toHaveBeenCalledTimes(1);
  });
});
