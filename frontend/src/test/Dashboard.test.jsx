import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../pages/Dashboard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
  }),
}));

const authState = vi.hoisted(() => ({
  user: { role: 'contributor' },
  updateUser: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    token: 'token',
    ready: true,
    updateUser: authState.updateUser,
  }),
}));

vi.mock('../services/api', () => ({
  api: {
    getMyBalance: vi.fn().mockResolvedValue({ balance: {} }),
    getMe: vi.fn().mockResolvedValue({}),
    getMyStats: vi.fn().mockResolvedValue({}),
    getMyCampaigns: vi.fn().mockResolvedValue([]),
    getUserDashboardAnalytics: vi.fn().mockResolvedValue([]),
    getCampaignAnalytics: vi.fn().mockResolvedValue({}),
    getCampaignAnalyticsContributors: vi.fn().mockResolvedValue([]),
    getReferralLeaderboard: vi.fn().mockResolvedValue([]),
    getMilestones: vi.fn().mockResolvedValue([]),
    getCampaign: vi.fn().mockResolvedValue({}),
    getKycStatus: vi.fn().mockResolvedValue({ status: 'verified' }),
  },
}));

vi.mock('../components/KycPrompt', () => ({
  default: () => <div data-testid="kyc-prompt" />,
}));

vi.mock('../components/VerificationBadge', () => ({
  default: () => <div data-testid="verification-badge" />,
}));

vi.mock('../components/CampaignStatusBadge', () => ({
  default: () => <div data-testid="campaign-status-badge" />,
}));

vi.mock('../components/ContributorDashboard', () => ({
  default: () => <div data-testid="contributor-dashboard" />,
}));

vi.mock('../components/DepositModal', () => ({
  default: () => null,
}));

vi.mock('../components/ApiKeysPanel', () => ({
  default: () => <div data-testid="api-keys-panel" />,
}));

describe('Dashboard tabs', () => {
  beforeEach(() => {
    authState.user = { role: 'contributor' };
    authState.updateUser.mockReset();
  });

  it('hides analytics and referrals tabs for contributors but shows them for creators', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    expect(screen.queryByRole('tab', { name: /analytics/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /referrals/i })).not.toBeInTheDocument();

    authState.user = { role: 'creator' };

    rerender(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    expect(await screen.findByRole('tab', { name: /analytics/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /referrals/i })).toBeInTheDocument();
  });
});
