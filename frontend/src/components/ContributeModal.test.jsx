import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContributeModal from './ContributeModal';

vi.mock('@stellar/freighter-api', () => ({
  getNetwork: vi.fn(),
  isConnected: vi.fn().mockResolvedValue({ isConnected: false }),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    token: 'test-token',
    user: {
      wallet_public_key: 'GUSER',
      kyc_status: 'verified',
      kyc_required_for_campaigns: true,
    },
    updateUser: vi.fn(),
  }),
}));

const mockContribute = vi.fn();
const mockQuote = vi.fn();
const mockOnClose = vi.fn();
const mockOnSuccess = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getPlatformConfig: vi.fn().mockResolvedValue({ platform_fee_bps: 0 }),
    getContributions: vi.fn().mockResolvedValue([]),
    getAnchorInfo: vi.fn().mockResolvedValue({ anchors: [] }),
    quoteContribution: (...args) => mockQuote(...args),
    contribute: (...args) => mockContribute(...args),
  },
}));

const campaign = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Test Campaign',
  asset_type: 'USDC',
  status: 'active',
};

describe('ContributeModal', () => {
  beforeEach(() => {
    mockContribute.mockReset();
    mockQuote.mockReset();
    mockOnClose.mockReset();
    mockOnSuccess.mockReset();
    mockQuote.mockResolvedValue({
      send_asset: 'XLM',
      dest_asset: 'USDC',
      dest_amount: '10',
      max_send_amount: '12',
      path: ['USDC'],
    });
    mockContribute.mockResolvedValue({ tx_hash: 'abc123' });
  });

  function renderModal(overrides = {}) {
    return render(
      <ContributeModal
        campaign={{ ...campaign, ...overrides }}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );
  }

  it('renders the contribution form when opened', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/support this campaign/i)).toBeInTheDocument();
  });

  it('validates that amount must be a positive number', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '0');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(screen.getByText(/enter an amount greater than zero/i)).toBeInTheDocument();
    expect(mockContribute).not.toHaveBeenCalled();
  });

  it('shows conversion preview when a quote is returned', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('radio', { name: /XLM/i }));
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '25');
    await waitFor(() => {
      expect(mockQuote).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText(/up to/i)).toBeInTheDocument();
    });
  });

  it('calls submit handler with the correct payload', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '15');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    await waitFor(() => {
      expect(mockContribute).toHaveBeenCalledWith(
        expect.objectContaining({
          campaign_id: campaign.id,
          amount: '15',
          send_asset: 'USDC',
        }),
        'test-token'
      );
    });
  });

  it('validates minimum contribution limit', async () => {
    const user = userEvent.setup();
    renderModal({ min_contribution: '5' });
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '4');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(await screen.findByText(/Minimum contribution is 5 USDC/i)).toBeInTheDocument();
    expect(mockContribute).not.toHaveBeenCalled();
  });

  it('validates maximum contribution limit', async () => {
    const user = userEvent.setup();
    renderModal({ max_contribution: '100' });
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '101');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(await screen.findByText(/Maximum contribution is 100 USDC/i)).toBeInTheDocument();
    expect(mockContribute).not.toHaveBeenCalled();
  });

  it('validates cumulative per-contributor cap', async () => {
    const { api } = await import('../services/api');
    api.getContributions.mockResolvedValueOnce({
      contributions: [
        { sender_public_key: 'GUSER', amount: '30' }
      ]
    });

    const user = userEvent.setup();
    renderModal({ max_per_user: '50' });
    
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '25');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    
    expect(await screen.findByText(/You have already contributed 30 USDC. The per-contributor limit is 50./i)).toBeInTheDocument();
    expect(mockContribute).not.toHaveBeenCalled();
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mockOnClose).toHaveBeenCalled();
  });
});
