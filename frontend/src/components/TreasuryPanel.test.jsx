import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TreasuryPanel, { TreasuryTransparencyPanel, describeRejection } from './TreasuryPanel';

const getTreasuryStatus = vi.fn();
const requestTreasuryWithdrawal = vi.fn();
const approveTreasuryWithdrawal = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getTreasuryStatus: (...args) => getTreasuryStatus(...args),
    requestTreasuryWithdrawal: (...args) => requestTreasuryWithdrawal(...args),
    approveTreasuryWithdrawal: (...args) => approveTreasuryWithdrawal(...args),
  },
}));

function status(overrides = {}) {
  return {
    contractId: 'CTREASURY123',
    totalReceived: '10000.0000000',
    totalWithdrawn: '2500.0000000',
    available: '7500.0000000',
    paused: false,
    policy: {
      minHoldDays: 30,
      maxSingleWithdrawalPct: 25,
      withdrawalCooldownHours: 24,
      requireAuditorForAbove: '5000.0000000',
      autoRefundOnMiss: true,
    },
    withdrawalHistory: [],
    pendingWithdrawals: [],
    ...overrides,
  };
}

function rejection(code) {
  const err = new Error(`Treasury rejected the call: ${code}`);
  err.code = code;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TreasuryPanel', () => {
  it('shows balances and the policy the contract holds', async () => {
    getTreasuryStatus.mockResolvedValue(status());
    render(<TreasuryPanel campaignId="c-1" assetType="USDC" />);

    await waitFor(() => expect(screen.getByText(/Available:/)).toBeInTheDocument());
    expect(screen.getByText(/7,500/)).toBeInTheDocument();
    expect(screen.getByText(/Max single withdrawal: 25%/)).toBeInTheDocument();
    expect(screen.getByText(/Cooldown: 24 hours/)).toBeInTheDocument();
  });

  it('warns before submitting that a large amount will need the auditor', async () => {
    getTreasuryStatus.mockResolvedValue(status());
    render(<TreasuryPanel campaignId="c-1" />);
    await waitFor(() => expect(screen.getByLabelText('Amount')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Amount'), '6000');
    expect(screen.getByText(/will need auditor approval/i)).toBeInTheDocument();
  });

  it('reports a parked withdrawal instead of claiming it executed', async () => {
    getTreasuryStatus.mockResolvedValue(status());
    requestTreasuryWithdrawal.mockResolvedValue({ type: 'pending_auditor', pendingId: 7 });
    render(<TreasuryPanel campaignId="c-1" />);
    await waitFor(() => expect(screen.getByLabelText('Amount')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Amount'), '6000');
    await userEvent.type(screen.getByLabelText('Destination'), 'GDEST');
    await userEvent.click(screen.getByRole('button', { name: /request withdrawal/i }));

    await waitFor(() =>
      expect(screen.getByText(/Sent to the auditor for approval/i)).toBeInTheDocument()
    );
  });

  it('explains a policy rejection in terms the creator can act on', async () => {
    getTreasuryStatus.mockResolvedValue(status());
    requestTreasuryWithdrawal.mockRejectedValue(rejection('EXCEEDS_MAX_WITHDRAWAL_PCT'));
    render(<TreasuryPanel campaignId="c-1" />);
    await waitFor(() => expect(screen.getByLabelText('Amount')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Amount'), '3000');
    await userEvent.type(screen.getByLabelText('Destination'), 'GDEST');
    await userEvent.click(screen.getByRole('button', { name: /request withdrawal/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/larger share of the balance than the policy allows/i)
      ).toBeInTheDocument()
    );
  });

  it('offers the approve action only to the auditor', async () => {
    getTreasuryStatus.mockResolvedValue(
      status({
        pendingWithdrawals: [
          {
            id: 7,
            amount: '6000.0000000',
            destination: 'GDEST',
            createdAt: '2026-08-01T00:00:00Z',
          },
        ],
      })
    );

    const { unmount } = render(<TreasuryPanel campaignId="c-1" isAuditor={false} />);
    await waitFor(() => expect(screen.getByText(/Awaiting auditor approval/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    unmount();

    render(<TreasuryPanel campaignId="c-1" isAuditor />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    );
  });

  it('approves a pending withdrawal through the auditor endpoint', async () => {
    getTreasuryStatus.mockResolvedValue(
      status({
        pendingWithdrawals: [
          {
            id: 7,
            amount: '6000.0000000',
            destination: 'GDEST',
            createdAt: '2026-08-01T00:00:00Z',
          },
        ],
      })
    );
    approveTreasuryWithdrawal.mockResolvedValue({ status: 'completed' });

    render(<TreasuryPanel campaignId="c-1" isAuditor />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(approveTreasuryWithdrawal).toHaveBeenCalledWith('c-1', 7));
  });

  it('falls back to a plain message for a standard multisig campaign', async () => {
    getTreasuryStatus.mockRejectedValue(rejection('NOT_CONTRACT_WALLET'));
    render(<TreasuryPanel campaignId="c-1" />);
    await waitFor(() => expect(screen.getByText(/standard multisig wallet/i)).toBeInTheDocument());
  });

  it('lists executed withdrawals with who approved them', async () => {
    getTreasuryStatus.mockResolvedValue(
      status({
        withdrawalHistory: [
          {
            id: 1,
            amount: '2500.0000000',
            destination: 'GDEST',
            executedAt: '2026-08-01T00:00:00Z',
            requester: 'GCREATOR',
            approvedBy: 'GAUDITOR',
          },
        ],
      })
    );
    render(<TreasuryPanel campaignId="c-1" />);
    await waitFor(() => expect(screen.getByText('Auditor')).toBeInTheDocument());
  });
});

describe('TreasuryTransparencyPanel', () => {
  it('links to the contract and shows the policy publicly', async () => {
    getTreasuryStatus.mockResolvedValue(status());
    render(<TreasuryTransparencyPanel campaignId="c-1" assetType="USDC" />);

    await waitFor(() =>
      expect(screen.getByText(/Funds secured by a Soroban contract/i)).toBeInTheDocument()
    );
    const link = screen.getByRole('link', { name: /Stellar Expert/i });
    expect(link.getAttribute('href')).toContain('CTREASURY123');
    expect(screen.getByText(/30 days after the deadline/)).toBeInTheDocument();
  });

  it('renders nothing for a campaign without a contract treasury', async () => {
    getTreasuryStatus.mockRejectedValue(rejection('NOT_CONTRACT_WALLET'));
    const { container } = render(<TreasuryTransparencyPanel campaignId="c-1" />);
    await waitFor(() => expect(container.textContent).not.toMatch(/Loading treasury/));
    expect(container.textContent).toBe('');
  });

  it('surfaces a paused treasury to contributors', async () => {
    getTreasuryStatus.mockResolvedValue(status({ paused: true }));
    render(<TreasuryTransparencyPanel campaignId="c-1" />);
    await waitFor(() => expect(screen.getByText(/currently paused/i)).toBeInTheDocument());
  });
});

describe('describeRejection', () => {
  it('maps every documented contract code to specific guidance', () => {
    const codes = [
      'HOLD_PERIOD_NOT_ELAPSED',
      'EXCEEDS_MAX_WITHDRAWAL_PCT',
      'COOLDOWN_NOT_ELAPSED',
      'INSUFFICIENT_BALANCE',
      'TREASURY_PAUSED',
      'AUDITOR_NOT_CONFIGURED',
    ];
    for (const code of codes) {
      const message = describeRejection({ code });
      expect(message).toBeTruthy();
      expect(message).not.toMatch(/undefined/);
    }
  });

  it('falls back to the server message for an unknown code', () => {
    expect(describeRejection({ code: 'WAT', message: 'something else' })).toBe('something else');
  });
});
