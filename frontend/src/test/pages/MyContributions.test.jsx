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

  it('renders contribution refund status and estimated completion time', async () => {
    apiMocks.getContributorDashboard.mockResolvedValueOnce({
      stats: {
        total_contributed: 100,
        campaigns_backed: 1,
        active_campaigns_backed: 0,
        campaigns_completed: 0,
        avg_contribution: 100,
        total_refunded: 0,
        badges: [],
      },
      campaigns: [
        {
          campaign_id: 'camp-1',
          title: 'Failed Eco Project',
          status: 'failed',
          target_amount: 1000,
          raised_amount: 100,
          asset_type: 'XLM',
          contributed_amount: 100,
          escrow_contract_id: null,
          contributions: [
            {
              id: 'c-1',
              amount: 100,
              asset: 'XLM',
              created_at: '2026-09-01T12:00:00.000Z',
              refund_status: 'pending',
              estimated_time_text: 'Within 24–48 hours',
            },
          ],
        },
      ],
    });

    renderWithProviders(<MyContributions />);

    expect(await screen.findByText('Failed Eco Project')).toBeInTheDocument();
    const estElements = await screen.findAllByText(/Est\. completion: Within 24–48 hours/i);
    expect(estElements.length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/Refund pending/i)).toBeInTheDocument();
  });
});
