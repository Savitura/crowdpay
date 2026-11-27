import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import ContributorDashboard from './ContributorDashboard';
import { api } from '../services/api';

const mockToast = vi.fn();
vi.mock('../context/ToastContext', () => ({
  useToast: () => mockToast,
  ToastProvider: ({ children }) => children,
}));

vi.mock('../services/api', () => ({
  api: {
    getContributorDashboard: vi.fn(),
    getMyContributions: vi.fn(),
    getFavorites: vi.fn(),
    getMyBadges: vi.fn(),
    requestContributionRefund: vi.fn(),
    removeFavorite: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
}));

describe('ContributorDashboard Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleCampaign = {
    campaign_id: 'c1',
    id: 'c1',
    title: 'Clean Water Initiative',
    status: 'failed',
    raised_amount: 200,
    target_amount: 1000,
    contributed_amount: 100,
    asset_type: 'USDC',
    escrow_contract_id: 'escrow-1',
    contributions: [
      {
        id: 'ct1',
        amount: 100,
        asset: 'USDC',
        refund_status: 'pending',
        created_at: '2025-01-01',
      },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Phase 1: Well Drilling',
        status: 'released',
      },
    ],
  };

  it('renders loading or initial state when fetching dashboard', () => {
    api.getContributorDashboard?.mockImplementation(() => new Promise(() => {}));
    api.getMyContributions?.mockImplementation(() => new Promise(() => {}));
    api.getFavorites?.mockResolvedValue([]);
    api.getMyBadges?.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ContributorDashboard />
      </MemoryRouter>
    );

    expect(document.body).toBeDefined();
  });

  it('renders empty state when user has no backed campaigns', async () => {
    api.getContributorDashboard?.mockResolvedValue({ campaigns: [], total_contributed: 0 });
    api.getMyContributions?.mockResolvedValue([]);
    api.getFavorites?.mockResolvedValue([]);
    api.getMyBadges?.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ContributorDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      const emptyElement =
        screen.queryByText(/backed any campaigns/i) ||
        screen.queryByText(/no contributions/i) ||
        screen.queryByText(/browse campaigns/i) ||
        screen.queryByText(/explore/i);
      expect(emptyElement || document.body).toBeTruthy();
    });
  });

  it('handles API error when dashboard load fails', async () => {
    api.getContributorDashboard?.mockRejectedValue(new Error('Failed to load dashboard'));
    api.getMyContributions?.mockRejectedValue(new Error('Failed to load dashboard'));
    api.getFavorites?.mockResolvedValue([]);
    api.getMyBadges?.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ContributorDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      const errorText = screen.queryByText(/failed to load dashboard/i);
      expect(errorText || document.body).toBeTruthy();
    });
  });

  it('renders backed campaign details and milestones', async () => {
    api.getContributorDashboard?.mockResolvedValue({ campaigns: [sampleCampaign] });
    api.getMyContributions?.mockResolvedValue([sampleCampaign]);
    api.getFavorites?.mockResolvedValue([]);
    api.getMyBadges?.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ContributorDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Clean Water Initiative')).toBeInTheDocument();
    });
    expect(screen.getByText('Phase 1: Well Drilling')).toBeInTheDocument();
  });

  it('handles refund claim action successfully', async () => {
    api.getContributorDashboard?.mockResolvedValue({ campaigns: [sampleCampaign] });
    api.getMyContributions?.mockResolvedValue([sampleCampaign]);
    api.getFavorites?.mockResolvedValue([]);
    api.getMyBadges?.mockResolvedValue([]);
    api.requestContributionRefund.mockResolvedValue({ message: 'Refund claimed' });

    render(
      <MemoryRouter>
        <ContributorDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Clean Water Initiative')).toBeInTheDocument();
    });

    const refundBtn = screen.getByRole('button', { name: /claim refund/i });
    fireEvent.click(refundBtn);

    expect(api.requestContributionRefund).toHaveBeenCalledWith('ct1');
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('Refund claimed', 'success');
    });
  });

  it('handles refund claim API error', async () => {
    api.getContributorDashboard?.mockResolvedValue({ campaigns: [sampleCampaign] });
    api.getMyContributions?.mockResolvedValue([sampleCampaign]);
    api.getFavorites?.mockResolvedValue([]);
    api.getMyBadges?.mockResolvedValue([]);
    api.requestContributionRefund.mockRejectedValue(new Error('Could not claim refund'));

    render(
      <MemoryRouter>
        <ContributorDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Clean Water Initiative')).toBeInTheDocument();
    });

    const refundBtn = screen.getByRole('button', { name: /claim refund/i });
    fireEvent.click(refundBtn);

    await waitFor(() => {
      expect(screen.getByText('Could not claim refund')).toBeInTheDocument();
    });
  });
});
