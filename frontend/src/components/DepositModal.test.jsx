import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DepositModal from './DepositModal';

const mockGetMyBalance = vi.fn();
const mockGetSep24Assets = vi.fn();
const mockStartWalletDeposit = vi.fn();
const mockGetAnchorDepositStatus = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getMyBalance: (...args) => mockGetMyBalance(...args),
    getSep24Assets: (...args) => mockGetSep24Assets(...args),
    startWalletDeposit: (...args) => mockStartWalletDeposit(...args),
    getAnchorDepositStatus: (...args) => mockGetAnchorDepositStatus(...args),
  },
}));

const ANCHOR = {
  id: 'anchor-1',
  name: 'MoneyGram',
  available: true,
  asset: { code: 'USDC' },
  rails: ['bank_transfer'],
  environment: 'testnet',
};

function setup({ balance = { USDC: 0 }, anchors = [ANCHOR] } = {}) {
  mockGetMyBalance.mockResolvedValue({ balance });
  mockGetSep24Assets.mockResolvedValue({ anchors });
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const utils = render(<DepositModal onClose={onClose} onSuccess={onSuccess} />);
  return { ...utils, onClose, onSuccess };
}

describe('DepositModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.open = vi.fn(() => ({ closed: false, location: {}, close: vi.fn() }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the deposit form and auto-selects the first available anchor', async () => {
    setup();

    expect(await screen.findByText('Add Funds')).toBeInTheDocument();
    const radio = await screen.findByRole('radio', { name: /MoneyGram/i });
    expect(radio).toBeChecked();
  });

  it('shows the current wallet balance once loaded', async () => {
    setup({ balance: { USDC: 42.5 } });

    expect(await screen.findByText(/Current wallet balance/i)).toBeInTheDocument();
    expect(await screen.findByText(/42.5 USDC/)).toBeInTheDocument();
  });

  it('shows a validation error for a zero or empty amount', async () => {
    const user = userEvent.setup();
    setup();

    await screen.findByRole('radio', { name: /MoneyGram/i });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an amount greater than zero.'
    );
    expect(mockStartWalletDeposit).not.toHaveBeenCalled();
  });

  it('shows an error when no anchor is available', async () => {
    const user = userEvent.setup();
    setup({ anchors: [] });

    const amountInput = await screen.findByLabelText(/Amount/i);
    await user.type(amountInput, '10');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No deposit anchor is available.');
  });

  it('starts the deposit flow and transitions to the anchor phase on submit', async () => {
    const user = userEvent.setup();
    mockStartWalletDeposit.mockResolvedValue({
      id: 'session-1',
      interactive_url: 'https://anchor.example/interactive',
      status: 'pending',
    });
    mockGetAnchorDepositStatus.mockResolvedValue({
      id: 'session-1',
      status: 'pending',
    });

    setup();

    const amountInput = await screen.findByLabelText(/Amount/i);
    await user.type(amountInput, '25');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Complete your deposit')).toBeInTheDocument();
    expect(mockStartWalletDeposit).toHaveBeenCalledWith({
      amount: '25',
      anchor_id: 'anchor-1',
    });
  });

  it('shows an error and returns to the form when starting the deposit fails', async () => {
    const user = userEvent.setup();
    mockStartWalletDeposit.mockRejectedValue(new Error('Anchor unavailable'));

    setup();

    const amountInput = await screen.findByLabelText(/Amount/i);
    await user.type(amountInput, '5');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Anchor unavailable');
    expect(screen.getByText('Add Funds')).toBeInTheDocument();
  });

  it('polls the deposit status and calls onSuccess once completed', async () => {
    const user = userEvent.setup();
    mockStartWalletDeposit.mockResolvedValue({
      id: 'session-1',
      interactive_url: 'https://anchor.example/interactive',
      status: 'pending',
    });
    mockGetAnchorDepositStatus.mockResolvedValue({
      id: 'session-1',
      status: 'completed',
    });

    const { onSuccess } = setup();

    const amountInput = await screen.findByLabelText(/Amount/i);
    await user.type(amountInput, '25');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Deposit submitted')).toBeInTheDocument();
  });

  it('surfaces a friendly error and returns to the form when the deposit fails', async () => {
    const user = userEvent.setup();
    mockStartWalletDeposit.mockResolvedValue({
      id: 'session-1',
      interactive_url: 'https://anchor.example/interactive',
      status: 'pending',
    });
    mockGetAnchorDepositStatus.mockResolvedValue({
      id: 'session-1',
      status: 'failed',
      last_anchor_status: 'too_small',
    });

    setup();

    const amountInput = await screen.findByLabelText(/Amount/i);
    await user.type(amountInput, '25');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('Deposit amount is below the minimum limit allowed by the partner.')
    ).toBeInTheDocument();
    expect(screen.getByText('Add Funds')).toBeInTheDocument();
  });

  async function enterAnchorPhaseWithFakeTimers() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockStartWalletDeposit.mockResolvedValue({
      id: 'session-1',
      interactive_url: 'https://anchor.example/interactive',
      status: 'pending',
    });

    const utils = setup();

    const amountInput = await screen.findByLabelText(/Amount/i);
    await user.type(amountInput, '25');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Complete your deposit');
    await waitFor(() => expect(mockGetAnchorDepositStatus).toHaveBeenCalledTimes(1));

    return utils;
  }

  it('backs off exponentially between failed status polls', async () => {
    mockGetAnchorDepositStatus.mockRejectedValue(new Error('Network down'));

    await enterAnchorPhaseWithFakeTimers();

    for (const [index, delay] of [5000, 10000, 20000, 40000].entries()) {
      expect(
        await screen.findByText(
          new RegExp(`Retrying in ${delay / 1000}s — attempt ${index + 2} of 5`)
        )
      ).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(delay);
      await waitFor(() => expect(mockGetAnchorDepositStatus).toHaveBeenCalledTimes(index + 2));
    }
  });

  it('stops polling after the retry limit and surfaces an error', async () => {
    mockGetAnchorDepositStatus.mockRejectedValue(new Error('Network down'));

    await enterAnchorPhaseWithFakeTimers();

    await vi.advanceTimersByTimeAsync(5000 + 10000 + 20000 + 40000);

    await waitFor(() => expect(mockGetAnchorDepositStatus).toHaveBeenCalledTimes(5));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /stopped checking your deposit status after 5 failed attempts/i
    );

    // No further requests once the limit is hit.
    await vi.advanceTimersByTimeAsync(120000);
    expect(mockGetAnchorDepositStatus).toHaveBeenCalledTimes(5);
  });

  it('resets the backoff after a successful poll', async () => {
    mockGetAnchorDepositStatus
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValue({ id: 'session-1', status: 'pending' });

    await enterAnchorPhaseWithFakeTimers();

    expect(await screen.findByText(/Retrying in 5s/)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => expect(mockGetAnchorDepositStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Retrying in/)).not.toBeInTheDocument());

    // Back to the steady-state interval, not the escalated delay.
    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(mockGetAnchorDepositStatus).toHaveBeenCalledTimes(3));
  });

  it('calls onClose when the Cancel button is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();

    await screen.findByRole('radio', { name: /MoneyGram/i });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
