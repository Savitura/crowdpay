import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContributeModal from './ContributeModal';

const randomUUID = vi.fn(() => 'idem-key-123');

Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID,
  },
  configurable: true,
});

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
const mockPrepareContribution = vi.fn();
const mockSubmitSignedContribution = vi.fn();
const mockOnClose = vi.fn();
const mockOnSuccess = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getPlatformConfig: vi.fn().mockResolvedValue({
      platform_fee_bps: 0,
      usdc_issuer: 'GBBD472Q6TDQNCA24G2UG4M326T7J62TK2TYWNDSTXT5VBN2O4OXCT3U',
    }),
    getContributions: vi.fn().mockResolvedValue([]),
    getAnchorInfo: vi.fn().mockResolvedValue({ anchors: [] }),
    quoteContribution: (...args) => mockQuote(...args),
    contribute: (...args) => mockContribute(...args),
    prepareContribution: (...args) => mockPrepareContribution(...args),
    submitSignedContribution: (...args) => mockSubmitSignedContribution(...args),
  },
}));

const campaign = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Test Campaign',
  asset_type: 'USDC',
  status: 'active',
  wallet_public_key: 'GCAMPAIGNWALLET12345678901234567890123456789012345678901234',
};

describe('ContributeModal', () => {
  beforeEach(() => {
    randomUUID.mockClear();
    mockContribute.mockReset();
    mockQuote.mockReset();
    mockPrepareContribution.mockReset();
    mockSubmitSignedContribution.mockReset();
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
    expect(screen.getByText(/payment method/i)).toBeInTheDocument();
  });

  it('pre-populates amount when initialAmount is provided', () => {
    render(
      <ContributeModal
        campaign={campaign}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        initialAmount="50"
      />
    );
    expect(screen.getByLabelText(/amount campaign receives/i)).toHaveValue(50);
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
          idempotency_key: 'idem-key-123',
        }),
        {}
      );
    });
  });

  it('forwards the referral code as a ?ref query parameter', async () => {
    const user = userEvent.setup();
    render(
      <ContributeModal
        campaign={campaign}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        referralCode="a1b2c3d4"
      />
    );
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '15');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    await waitFor(() => {
      expect(mockContribute).toHaveBeenCalledWith(
        expect.objectContaining({ campaign_id: campaign.id }),
        { query: { ref: 'a1b2c3d4' } }
      );
    });
  });

  it('disables submit immediately and blocks duplicate rapid submissions', async () => {
    let resolveContribution;
    mockContribute.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveContribution = resolve;
        })
    );

    const user = userEvent.setup();
    renderModal();
    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '15');

    const submitButton = screen.getByRole('button', { name: /confirm payment/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockContribute).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /submitting/i })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });

    await user.click(screen.getByRole('button', { name: /submitting/i }));
    expect(mockContribute).toHaveBeenCalledTimes(1);

    resolveContribution({ tx_hash: 'abc123' });
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
      contributions: [{ sender_public_key: 'GUSER', amount: '30' }],
    });

    const user = userEvent.setup();
    renderModal({ max_per_user: '50' });

    await user.clear(screen.getByLabelText(/amount campaign receives/i));
    await user.type(screen.getByLabelText(/amount campaign receives/i), '25');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));

    expect(
      await screen.findByText(
        /You have already contributed 30 USDC. The per-contributor limit is 50./i
      )
    ).toBeInTheDocument();
    expect(mockContribute).not.toHaveBeenCalled();
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  describe('Freighter signing timeout and cancellation', () => {
    const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

    afterEach(() => {
      vi.useRealTimers();
    });

    async function startSigning() {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const freighterApi = await import('@stellar/freighter-api');
      freighterApi.isConnected.mockResolvedValue({ isConnected: true });
      freighterApi.requestAccess.mockResolvedValue({ address: 'GSIGNER' });
      freighterApi.getNetwork.mockResolvedValue({
        network: 'TESTNET',
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      // Freighter never settles when its popup is dismissed or hangs.
      freighterApi.signTransaction.mockReturnValue(new Promise(() => {}));
      mockPrepareContribution.mockResolvedValue({
        unsigned_xdr: 'UNSIGNED_XDR',
        prepare_token: 'prepare-token',
        network_passphrase: NETWORK_PASSPHRASE,
        network_name: 'testnet',
      });

      renderModal();
      await user.click(screen.getByRole('radio', { name: /my own wallet/i }));
      await user.clear(screen.getByLabelText(/amount campaign receives/i));
      await user.type(screen.getByLabelText(/amount campaign receives/i), '15');
      await user.click(screen.getByRole('button', { name: /review in freighter/i }));

      await waitFor(() => expect(freighterApi.signTransaction).toHaveBeenCalled());
      return { user };
    }

    it('shows a Cancel signing button while waiting for the signature', async () => {
      await startSigning();

      expect(
        await screen.findByRole('button', { name: /cancel signing/i })
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    });

    it('times out after 60 seconds instead of hanging in the signing state', async () => {
      await startSigning();

      await vi.advanceTimersByTimeAsync(59000);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(1000);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /did not return a signature within 60 seconds/i
      );
      expect(mockSubmitSignedContribution).not.toHaveBeenCalled();
      // Submission is unlocked so the contributor can retry.
      expect(screen.getByRole('button', { name: /review in freighter/i })).toBeEnabled();
    });

    it('aborts the signing attempt when Cancel signing is clicked', async () => {
      const { user } = await startSigning();

      await user.click(await screen.findByRole('button', { name: /cancel signing/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/signing cancelled/i);
      expect(mockSubmitSignedContribution).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /review in freighter/i })).toBeEnabled();
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('Freighter fallback panel', () => {
    beforeEach(async () => {
      const freighterApi = await import('@stellar/freighter-api');
      freighterApi.isConnected.mockResolvedValue({ isConnected: false });
    });

    it('always shows the Freighter payment option regardless of extension availability', async () => {
      renderModal();
      await waitFor(() => {
        expect(screen.getByRole('radio', { name: /my own wallet/i })).toBeInTheDocument();
      });
    });

    it('shows the fallback panel when Freighter option is selected but extension absent', async () => {
      const user = userEvent.setup();
      renderModal();
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: /my own wallet/i })).toBeInTheDocument()
      );
      await user.click(screen.getByRole('radio', { name: /my own wallet/i }));
      await waitFor(() =>
        expect(screen.getByText(/No wallet extension detected/i)).toBeInTheDocument()
      );
    });

    it('shows the Install Freighter link in the fallback panel', async () => {
      const user = userEvent.setup();
      renderModal();
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: /my own wallet/i })).toBeInTheDocument()
      );
      await user.click(screen.getByRole('radio', { name: /my own wallet/i }));
      await waitFor(() => {
        const link = screen.getByRole('link', { name: /install freighter/i });
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', 'https://www.freighter.app/');
      });
    });
  });
});
