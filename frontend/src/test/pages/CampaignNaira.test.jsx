import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import Campaign from '../../pages/Campaign';
import { renderWithProviders } from '../renderWithProviders';

const mockUser = { id: 'user-1', role: 'donor', email: 'donor@example.com' };

const baseCampaign = {
  id: 'camp-123',
  title: 'Clean Water Project',
  description: 'Providing boreholes for communities in Enugu.',
  target_amount: 5000,
  raised_amount: 1200,
  asset_type: 'USDC',
  status: 'active',
  creator_id: 'user-creator',
};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'camp-123' }),
    useLocation: () => ({ pathname: '/campaigns/camp-123', search: '', hash: '', state: null }),
  };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    token: 'fake-token',
    ready: true,
  }),
}));

const apiProxy = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (target, prop) => {
          if (!target[prop]) {
            if (
              [
                'getCampaignUpdates',
                'getCampaignMembers',
                'getCampaignTiers',
                'getStretchGoals',
                'listWithdrawals',
                'getComments',
                'getCampaignTranslations',
                'getMilestones',
                'getWithdrawals',
                'getCampaignFulfillments',
              ].includes(prop)
            ) {
              target[prop] = vi.fn().mockResolvedValue([]);
            } else if (prop === 'getContributions') {
              target[prop] = vi.fn().mockResolvedValue({ contributions: [], total: 0 });
            } else if (prop === 'getCampaign') {
              target[prop] = vi.fn().mockResolvedValue(baseCampaign);
            } else if (prop === 'getExchangeRates') {
              target[prop] = vi.fn().mockResolvedValue({
                target: 'NGN',
                rates: { USDC: 1600, XLM: 160 },
                approximate: true,
              });
            } else {
              target[prop] = vi.fn().mockResolvedValue({});
            }
          }
          return target[prop];
        },
      }
    )
);

vi.mock('../../services/api', () => ({
  api: apiProxy,
  apiClient: {
    get: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

describe('Campaign page approximate Naira amounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders approximate Naira values for both raised and goal amounts', async () => {
    renderWithProviders(<Campaign />);

    await waitFor(() => {
      expect(screen.getByText('Clean Water Project')).toBeInTheDocument();
    });

    // Check that approximate Naira (₦... approx.) is rendered
    await waitFor(() => {
      const approxElements = screen.getAllByText(/₦.*approx/i);
      expect(approxElements.length).toBeGreaterThan(0);
    });
  });
});
