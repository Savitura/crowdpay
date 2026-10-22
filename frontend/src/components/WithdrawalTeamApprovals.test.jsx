import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WithdrawalTeamApprovals from './WithdrawalTeamApprovals';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getWithdrawalTeamPolicy: vi.fn(),
    setWithdrawalTeamPolicy: vi.fn(),
    listTeamWithdrawalRequests: vi.fn(),
    getWithdrawalTeamApprovals: vi.fn(),
    approveWithdrawalTeam: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  api.getWithdrawalTeamPolicy.mockResolvedValue({
    required_approvals: 1,
    eligible_other_owners: 2,
    can_manage: true,
  });
  api.listTeamWithdrawalRequests.mockResolvedValue({ data: [] });
});
describe('withdrawal team approvals', () => {
  it('lets the creator set a policy and explains snapshot compatibility', async () => {
    render(<WithdrawalTeamApprovals campaignId="campaign" token="token" />);
    const input = await screen.findByLabelText(/Other owner approvals required/);
    await userEvent.clear(input);
    await userEvent.type(input, '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save approval policy' }));
    await waitFor(() =>
      expect(api.setWithdrawalTeamPolicy).toHaveBeenCalledWith('campaign', 2, 'token')
    );
    expect(
      screen.getByText(/Pending requests keep their original requirement/)
    ).toBeInTheDocument();
  });
  it('shows request details and allows an eligible owner to approve', async () => {
    api.getWithdrawalTeamPolicy.mockResolvedValue({ required_approvals: 1, can_manage: false });
    api.listTeamWithdrawalRequests.mockResolvedValue({
      data: [
        {
          id: 'request',
          status: 'pending',
          team_approvals_required: 1,
          amount: '10',
          destination_key: 'GDEST',
          evidence: ['receipt'],
        },
      ],
    });
    api.getWithdrawalTeamApprovals.mockResolvedValue({
      approvals: 0,
      required_approvals: 1,
      can_approve: true,
    });
    render(<WithdrawalTeamApprovals campaignId="campaign" token="token" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve this withdrawal' }));
    await waitFor(() => expect(api.approveWithdrawalTeam).toHaveBeenCalledWith('request', 'token'));
    expect(screen.getByText('GDEST')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save approval policy' })).not.toBeInTheDocument();
  });
  it('shows server rejection without claiming a successful approval', async () => {
    api.setWithdrawalTeamPolicy.mockRejectedValue({
      status: 409,
      message: 'Not enough accepted owners',
    });
    render(<WithdrawalTeamApprovals campaignId="campaign" token="token" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save approval policy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough accepted owners');
  });
});
