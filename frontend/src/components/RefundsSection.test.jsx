import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RefundsSection from './RefundsSection';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getEligibleRefunds: vi.fn(),
    getCampaignRefunds: vi.fn(),
    processRefund: vi.fn(),
  },
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({
    show: vi.fn(),
  }),
}));

describe('RefundsSection', () => {
  const mockCampaign = {
    id: 'camp-123',
    creator_id: 'user-creator',
    asset_type: 'XLM',
  };

  const mockUser = {
    id: 'user-creator',
    role: 'user',
  };

  const mockAdminUser = {
    id: 'user-admin',
    role: 'admin',
  };

  const mockEligibleContributions = [
    {
      id: 'contrib-1',
      amount: '100',
      refunded_amount: '0',
      remaining_amount: '100',
      asset: 'XLM',
      status: 'completed',
      sender_public_key: 'GCONTRIBUTORWALLET123456789',
      contributor: {
        name: 'Alice Baker',
        email: 'alice@example.com',
        wallet_public_key: 'GCONTRIBUTORWALLET123456789',
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.getEligibleRefunds.mockResolvedValue({ items: mockEligibleContributions });
    api.getCampaignRefunds.mockResolvedValue({ items: [] });
  });

  it('renders eligible contributions for campaign creator', async () => {
    render(<RefundsSection campaign={mockCampaign} user={mockUser} />);

    expect(await screen.findByText('Alice Baker')).toBeInTheDocument();
    expect(screen.getAllByText('100 XLM').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /issue refund/i })).toBeInTheDocument();
  }, 20000);

  it('opens confirmation modal and processes refund upon confirmation', async () => {
    const user = userEvent.setup();
    api.processRefund.mockResolvedValue({ success: true });

    render(<RefundsSection campaign={mockCampaign} user={mockUser} />);

    const refundBtn = await screen.findByRole('button', { name: /issue refund/i });
    await user.click(refundBtn);

    expect(screen.getByTestId('refund-modal')).toBeInTheDocument();
    expect(screen.getByLabelText(/reason for refund/i)).toBeInTheDocument();

    const submitBtn = screen.getByTestId('submit-refund-btn');
    expect(submitBtn).toBeDisabled();

    const confirmCheckbox = screen.getByTestId('confirm-checkbox');
    await user.click(confirmCheckbox);
    expect(submitBtn).not.toBeDisabled();

    await user.click(submitBtn);

    await waitFor(() => {
      expect(api.processRefund).toHaveBeenCalledWith('camp-123', expect.objectContaining({
        contributionId: 'contrib-1',
        amount: 100,
      }));
    });
  }, 20000);

  it('renders admin force-refund controls for admin users', async () => {
    const user = userEvent.setup();
    render(<RefundsSection campaign={mockCampaign} user={mockAdminUser} />);

    const refundBtn = await screen.findByRole('button', { name: /issue refund/i });
    await user.click(refundBtn);

    expect(screen.getByTestId('admin-force-checkbox')).toBeInTheDocument();
  }, 20000);
});
