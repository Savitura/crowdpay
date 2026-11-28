import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GovernanceSyncRunsPanel from './GovernanceSyncRunsPanel';

const mockGetGovernanceSyncRuns = vi.fn();
const mockTriggerGovernanceSync = vi.fn();
const mockGetGovernanceSyncRun = vi.fn();
const mockRetryGovernanceSyncRun = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getGovernanceSyncRuns: (...args) => mockGetGovernanceSyncRuns(...args),
    triggerGovernanceSync: (...args) => mockTriggerGovernanceSync(...args),
    getGovernanceSyncRun: (...args) => mockGetGovernanceSyncRun(...args),
    retryGovernanceSyncRun: (...args) => mockRetryGovernanceSyncRun(...args),
  },
}));

const RUNS = [
  {
    id: 'run-succ-11111111',
    trigger: 'scheduled',
    status: 'succeeded',
    started_at: '2026-10-10T10:00:00.000Z',
    finished_at: '2026-10-10T10:00:00.450Z',
    proposals_seen: 5,
    proposals_updated: 3,
    proposals_missing: 0,
    error_code: null,
  },
  {
    id: 'run-fail-22222222',
    trigger: 'manual',
    status: 'failed',
    started_at: '2026-10-10T11:00:00.000Z',
    finished_at: '2026-10-10T11:00:02.500Z',
    proposals_seen: 4,
    proposals_updated: 1,
    proposals_missing: 1,
    error_code: 'RPC_TIMEOUT',
  },
  {
    id: 'run-curr-33333333',
    trigger: 'retry',
    status: 'running',
    started_at: '2026-10-10T12:00:00.000Z',
    finished_at: null,
    proposals_seen: 2,
    proposals_updated: 0,
    proposals_missing: 0,
    error_code: null,
  },
];

describe('GovernanceSyncRunsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders sync runs with status badges, counts, durations, and error codes', async () => {
    mockGetGovernanceSyncRuns.mockResolvedValue({ data: RUNS, total: 3 });

    render(<GovernanceSyncRunsPanel />);

    expect(screen.getByText('Loading runs…')).toBeInTheDocument();
    expect(await screen.findByText('RPC_TIMEOUT')).toBeInTheDocument();

    const succeededBadge = screen.getByText('succeeded', { selector: 'span' });
    expect(succeededBadge).toHaveClass('bg-green-100', 'text-green-800');

    const failedBadge = screen.getByText('failed', { selector: 'span' });
    expect(failedBadge).toHaveClass('bg-red-100', 'text-red-800');

    const runningBadge = screen.getByText('running', { selector: 'span' });
    expect(runningBadge).toHaveClass('bg-blue-100', 'text-blue-800');

    expect(screen.getByText('3/5')).toBeInTheDocument();
    expect(screen.getByText('450 ms')).toBeInTheDocument();
    expect(screen.getByText('2.5 s')).toBeInTheDocument();
    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1 · 3 runs')).toBeInTheDocument();
  });

  it('renders an empty state when no runs match filters', async () => {
    mockGetGovernanceSyncRuns.mockResolvedValue({ data: [], total: 0 });

    render(<GovernanceSyncRunsPanel />);

    expect(await screen.findByText('No sync runs match these filters.')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1 · 0 runs')).toBeInTheDocument();
  });

  it('reloads with status/trigger filters and paginates through results', async () => {
    const user = userEvent.setup();
    mockGetGovernanceSyncRuns.mockResolvedValue({ data: RUNS, total: 25 });

    render(<GovernanceSyncRunsPanel />);
    await screen.findByText('RPC_TIMEOUT');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(mockGetGovernanceSyncRuns).toHaveBeenLastCalledWith({ limit: 20, offset: 20 })
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();

    await user.selectOptions(screen.getByLabelText('Status'), 'failed');
    await waitFor(() =>
      expect(mockGetGovernanceSyncRuns).toHaveBeenLastCalledWith({
        limit: 20,
        offset: 0,
        status: 'failed',
      })
    );

    await user.selectOptions(screen.getByLabelText('Trigger'), 'manual');
    await waitFor(() =>
      expect(mockGetGovernanceSyncRuns).toHaveBeenLastCalledWith({
        limit: 20,
        offset: 0,
        status: 'failed',
        trigger: 'manual',
      })
    );
  });

  it('triggers manual sync, shows busy state, and handles success and failure results', async () => {
    const user = userEvent.setup();
    mockGetGovernanceSyncRuns.mockResolvedValue({ data: RUNS, total: 3 });
    let resolveSync;
    mockTriggerGovernanceSync.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSync = resolve;
      })
    );

    render(<GovernanceSyncRunsPanel />);
    await screen.findByText('RPC_TIMEOUT');

    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    const syncingBtn = screen.getByRole('button', { name: 'Syncing…' });
    expect(syncingBtn).toBeDisabled();
    expect(syncingBtn).toHaveAttribute('aria-busy', 'true');

    resolveSync({ success: true });
    expect(await screen.findByText('Sync finished.')).toBeInTheDocument();
    expect(mockGetGovernanceSyncRuns).toHaveBeenCalledTimes(2);

    mockTriggerGovernanceSync.mockResolvedValueOnce({ success: false });
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Sync failed. See the run history.')).toBeInTheDocument();
  });

  it('surfaces HTTP status-specific error notices on manual sync failures and load errors', async () => {
    const user = userEvent.setup();
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
    mockGetGovernanceSyncRuns
      .mockRejectedValueOnce(forbidden)
      .mockResolvedValue({ data: [], total: 0 });

    render(<GovernanceSyncRunsPanel />);
    expect(
      await screen.findByText('Only operators can manage governance sync runs.')
    ).toBeInTheDocument();

    mockTriggerGovernanceSync.mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), { status: 409 })
    );
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(
      await screen.findByText('A governance sync is already running. Wait for it to finish.')
    ).toBeInTheDocument();

    mockTriggerGovernanceSync.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { status: 502 })
    );
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(
      await screen.findByText('The sync run failed. See its error summary below.')
    ).toBeInTheDocument();

    mockTriggerGovernanceSync.mockRejectedValueOnce({});
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Could not start a sync')).toBeInTheDocument();
  });

  it('opens run detail on row click, allows retrying a failed run, and handles detail errors', async () => {
    const user = userEvent.setup();
    mockGetGovernanceSyncRuns.mockResolvedValue({ data: RUNS, total: 3 });
    mockGetGovernanceSyncRun.mockResolvedValueOnce({
      ...RUNS[1],
      provider_cursor: 'cursor-99',
      error_message: 'Soroban RPC timed out after 5s',
      retries: [],
    });
    mockRetryGovernanceSyncRun.mockResolvedValueOnce({ id: 'run-retry-1' });

    render(<GovernanceSyncRunsPanel />);
    await screen.findByText('RPC_TIMEOUT');

    await user.click(screen.getByText('RPC_TIMEOUT'));
    expect(await screen.findByText('Run run-fail')).toBeInTheDocument();
    expect(screen.getByText('cursor-99')).toBeInTheDocument();
    expect(screen.getByText(/Soroban RPC timed out after 5s/)).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'Retry run' });
    await user.click(retryBtn);
    await waitFor(() => expect(mockRetryGovernanceSyncRun).toHaveBeenCalledWith(RUNS[1].id));
    expect(mockGetGovernanceSyncRuns).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Run run-fail')).not.toBeInTheDocument();

    // Detail load error state
    mockGetGovernanceSyncRun.mockRejectedValueOnce(new Error('Run detail unavailable'));
    await user.click(screen.getByText('450 ms'));
    expect(await screen.findByText('Run detail unavailable')).toBeInTheDocument();
  });
});
