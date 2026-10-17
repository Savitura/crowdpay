import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import ReferralDashboard from '../../pages/ReferralDashboard';
import { renderWithProviders } from '../renderWithProviders';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-2', role: 'contributor' },
    ready: true,
    updateUser: vi.fn(),
  }),
}));

const apiMocks = vi.hoisted(() => ({
  getMyReferralLinks: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('ReferralDashboard page', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists referred campaigns with commission earned and status', async () => {
    apiMocks.getMyReferralLinks.mockResolvedValue({
      links: [
        {
          referral_link_id: 'link-1',
          code: 'a1b2c3d4',
          campaign_id: 'camp-1',
          campaign_title: 'Solar Wells',
          asset_type: 'USDC',
          commission_percentage: 10,
          contribution_count: 3,
          referred_amount: '600.0000000',
          commission_earned: '60.0000000',
          commission_owed: '60.0000000',
          status: 'pending',
          share_url: 'http://localhost:5173/c/camp-1?ref=a1b2c3d4',
        },
      ],
    });

    renderWithProviders(<ReferralDashboard />);

    expect(await screen.findByText('Solar Wells')).toBeInTheDocument();
    expect(screen.getByText('60.0000000 USDC')).toBeInTheDocument();
    expect(screen.getByText('Pending payout')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  it('shows an empty state when the user holds no referral links', async () => {
    apiMocks.getMyReferralLinks.mockResolvedValue({ links: [] });

    renderWithProviders(<ReferralDashboard />);

    expect(await screen.findByText(/no referral links yet/i)).toBeInTheDocument();
  });

  it('surfaces an error when the referrals request fails', async () => {
    apiMocks.getMyReferralLinks.mockRejectedValue(new Error('Referrals unavailable'));

    renderWithProviders(<ReferralDashboard />);

    expect(await screen.findByText('Referrals unavailable')).toBeInTheDocument();
  });
});
