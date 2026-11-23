import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Governance from '../../pages/Governance';
import { renderWithProviders } from '../renderWithProviders';

const mocks = vi.hoisted(() => ({
  authState: { user: { id: 'user-1', role: 'creator' } },
  api: {
    getGovernanceFee: vi.fn(),
    getGovernanceProposals: vi.fn(),
    getGovernanceUserTokenBalance: vi.fn(),
    getGovernanceProposal: vi.fn(),
    createGovernanceProposal: vi.fn(),
    voteGovernanceProposal: vi.fn(),
    executeGovernanceProposal: vi.fn(),
    submitSignedGovernance: vi.fn(),
  },
  freighter: {
    getNetwork: vi.fn(),
    signTransaction: vi.fn(),
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => mocks.authState,
}));

vi.mock('../../services/api', () => ({ api: mocks.api }));

vi.mock('@stellar/freighter-api', () => ({
  getNetwork: mocks.freighter.getNetwork,
  signTransaction: mocks.freighter.signTransaction,
}));

vi.mock('../../components/Navbar', () => ({
  default: () => <div data-testid="navbar" />,
}));

vi.mock('../../components/GovernanceSyncRunsPanel', () => ({
  default: () => <div data-testid="sync-runs-panel" />,
}));

const feeData = {
  platform_fee_bps: 250,
  platform_fee_percent: 2.5,
  creator_share_bps: 9750,
  creator_share_percent: 97.5,
  contract_id: 'CONTRACT123',
};

const activeProposalSummary = {
  id: 1,
  stellar_proposal_id: 42,
  proposed_fee_bps: 300,
  proposed_creator_share_bps: 9700,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
};

const activeProposalDetail = {
  ...activeProposalSummary,
  rationale_text: 'Lower the platform fee for creators',
  deadline: '2099-01-01T00:00:00Z',
  vote_stats: {
    votes_for: 10,
    votes_against: 2,
    participation_rate: 25,
  },
  outcome_projection: 'likely_pass',
};

async function renderLoadedGovernance() {
  const user = userEvent.setup();
  renderWithProviders(<Governance />);
  await screen.findByRole('heading', { name: 'Governance' });
  await screen.findByText('Active Proposal');
  return user;
}

describe('Governance page', () => {
  beforeEach(() => {
    mocks.authState.user = { id: 'user-1', role: 'creator' };
    mocks.api.getGovernanceFee.mockReset().mockResolvedValue(feeData);
    mocks.api.getGovernanceProposals.mockReset().mockResolvedValue({
      proposals: [activeProposalSummary],
    });
    mocks.api.getGovernanceUserTokenBalance.mockReset().mockResolvedValue({
      balance: '1000',
      can_propose: true,
      min_required: '100',
    });
    mocks.api.getGovernanceProposal.mockReset().mockResolvedValue({
      proposal: activeProposalDetail,
    });
    mocks.api.createGovernanceProposal.mockReset().mockResolvedValue({ mode: 'inline' });
    mocks.api.voteGovernanceProposal.mockReset().mockResolvedValue({ mode: 'inline' });
    mocks.api.executeGovernanceProposal.mockReset().mockResolvedValue({});
    mocks.api.submitSignedGovernance.mockReset().mockResolvedValue({});
    mocks.freighter.getNetwork.mockReset().mockResolvedValue({ networkPassphrase: 'test' });
    mocks.freighter.signTransaction.mockReset().mockResolvedValue({ signedTxXdr: 'signed-xdr' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state while governance data is fetched', () => {
    mocks.api.getGovernanceFee.mockReturnValueOnce(new Promise(() => {}));

    renderWithProviders(<Governance />);

    expect(screen.getByText('Loading governance data...')).toBeInTheDocument();
  });

  it('shows an error toast when governance data cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.api.getGovernanceFee.mockRejectedValueOnce(new Error('Fee service unavailable'));

    renderWithProviders(<Governance />);

    expect(await screen.findByText('Failed to load governance data')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Loading governance data...')).not.toBeInTheDocument();
    });
  });

  it('renders fee information, token balance, active proposal, and proposal history', async () => {
    await renderLoadedGovernance();

    expect(screen.getByText('250 bps (2.5%)')).toBeInTheDocument();
    expect(screen.getByText('1000 CROWD')).toBeInTheDocument();
    expect(screen.getByText('Lower the platform fee for creators')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('records a vote for the active proposal and disables voting while pending', async () => {
    let resolveVote;
    mocks.api.voteGovernanceProposal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveVote = resolve;
        })
    );
    const user = await renderLoadedGovernance();

    await user.click(screen.getByRole('button', { name: 'Vote For' }));

    await waitFor(() => {
      const votingButtons = screen.getAllByRole('button', { name: 'Voting...' });
      expect(votingButtons).toHaveLength(2);
      votingButtons.forEach((button) => expect(button).toBeDisabled());
    });
    expect(mocks.api.voteGovernanceProposal).toHaveBeenCalledWith(1, true);

    resolveVote({ mode: 'inline' });
    expect(await screen.findByText('Vote recorded successfully')).toBeInTheDocument();
  });

  it('records a vote against the active proposal', async () => {
    const user = await renderLoadedGovernance();

    await user.click(screen.getByRole('button', { name: 'Vote Against' }));

    expect(await screen.findByText('Vote recorded successfully')).toBeInTheDocument();
    expect(mocks.api.voteGovernanceProposal).toHaveBeenCalledWith(1, false);
  });

  it('shows an error toast when voting fails', async () => {
    mocks.api.voteGovernanceProposal.mockRejectedValueOnce(new Error('Vote rejected'));
    const user = await renderLoadedGovernance();

    await user.click(screen.getByRole('button', { name: 'Vote For' }));

    expect(await screen.findByText('Vote rejected')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Voting...' })).not.toBeInTheDocument();
    });
  });

  it('does not show voting controls to anonymous users', async () => {
    mocks.authState.user = null;
    await renderLoadedGovernance();

    expect(screen.queryByRole('button', { name: 'Vote For' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Vote Against' })).not.toBeInTheDocument();
    expect(mocks.api.getGovernanceUserTokenBalance).not.toHaveBeenCalled();
  });

  it('allows an ended active proposal to be executed', async () => {
    mocks.api.getGovernanceProposal.mockResolvedValueOnce({
      proposal: { ...activeProposalDetail, deadline: '2020-01-01T00:00:00Z' },
    });
    const user = await renderLoadedGovernance();

    expect(screen.getByText('Voting ended')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Execute Proposal' }));

    expect(mocks.api.executeGovernanceProposal).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Proposal executed successfully')).toBeInTheDocument();
  });
});
