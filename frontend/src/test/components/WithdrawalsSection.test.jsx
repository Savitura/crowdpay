import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import WithdrawalsSection from '../../components/WithdrawalsSection';

vi.mock('../../services/api', () => ({
  api: {
    getWithdrawalCapabilities: vi.fn(),
    listWithdrawals: vi.fn(),
    getCampaignBalance: vi.fn(),
    requestWithdrawal: vi.fn(),
  },
}));

import { api } from '../../services/api';

describe('WithdrawalsSection', () => {
  it('renders the release request form and submits a withdrawal request', async () => {
    const onReleased = vi.fn();
    const campaign = {
      id: 'campaign-1',
      creator_id: 'user-1',
      status: 'active',
      asset_type: 'USDC',
    };
    const user = { id: 'user-1', role: 'creator', wallet_public_key: 'GABCDEF' };

    api.getWithdrawalCapabilities.mockResolvedValue({ can_approve_platform: false });
    api.listWithdrawals.mockResolvedValue([]);
    api.getCampaignBalance.mockResolvedValue({ USDC: '250' });
    api.requestWithdrawal.mockResolvedValue({});

    renderWithProviders(
      <WithdrawalsSection
        campaign={campaign}
        milestones={[]}
        user={user}
        token="test-token"
        onReleased={onReleased}
      />
    );

    await screen.findByText(/Available on-chain:/i);
    await userEvent.type(screen.getByLabelText(/Destination address/i), 'GDEST12345');
    await userEvent.type(screen.getByLabelText(/Amount \(USDC\)/i), '200');
    await userEvent.type(screen.getByLabelText(/Evidence/i), 'https://example.com/receipt');
    await userEvent.click(screen.getByRole('button', { name: /Submit request/i }));

    await waitFor(() =>
      expect(api.requestWithdrawal).toHaveBeenCalledWith({
        campaign_id: 'campaign-1',
        destination_key: 'GDEST12345',
        amount: '200',
        evidence: ['https://example.com/receipt'],
      })
    );
    expect(onReleased).toHaveBeenCalled();
  });
});
