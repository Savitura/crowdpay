import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import NotificationSettings from '../../pages/NotificationSettings';

// Covers the per-campaign communication override section (#961) only. The
// account-level switches predate this feature and are not asserted here.
const mockUser = { id: 'user1', name: 'Alice', email: 'alice@example.com' };

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, ready: true }),
}));

const toast = vi.hoisted(() => vi.fn());

// Partial mock: keep the real ToastProvider (renderWithProviders mounts it) and
// only swap the hook so the assertions can read the calls.
vi.mock('../../context/ToastContext', async () => {
  const actual = await vi.importActual('../../context/ToastContext');
  return { ...actual, useToast: () => toast };
});

vi.mock('../../services/api', () => ({
  api: {
    getNotificationPreferences: vi.fn(),
    updateNotificationPreference: vi.fn(),
    unsubscribeEmail: vi.fn(),
    getMyCommunicationPreferences: vi.fn(),
    resetMyCommunicationPreferences: vi.fn(),
  },
}));

import { api } from '../../services/api';

const DEFAULTS = {
  campaign_updates: true,
  refunds: true,
  disputes: true,
  milestones: true,
  marketing: false,
};

const SECTION_HEADING = 'What should we tell you about?';

describe('NotificationSettings — per-campaign overrides (#961)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getNotificationPreferences.mockResolvedValue(DEFAULTS);
  });

  it('explains the empty state when nothing is muted on an individual campaign', async () => {
    api.getMyCommunicationPreferences.mockResolvedValue({ campaigns: [] });
    renderWithProviders(<NotificationSettings />);

    expect(
      await screen.findByText(
        'You have not muted anything on an individual campaign yet. Open any campaign you support and use the communication panel there to change that.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();
  });

  it('lists every muted campaign with only the channels that are off', async () => {
    api.getMyCommunicationPreferences.mockResolvedValue({
      campaigns: [
        {
          campaign_id: 'campaign-1',
          title: 'Solar grid',
          milestones: false,
          surveys: false,
        },
        { campaign_id: 'campaign-2', title: 'Water wells', funding_updates: false },
      ],
    });
    renderWithProviders(<NotificationSettings />);

    expect(await screen.findByText('Solar grid')).toBeInTheDocument();
    expect(screen.getByText('Water wells')).toBeInTheDocument();
    expect(screen.getByText('Milestones, Surveys and research')).toBeInTheDocument();
    expect(screen.getByText('Funding progress')).toBeInTheDocument();
  });

  it('links each row to its campaign', async () => {
    api.getMyCommunicationPreferences.mockResolvedValue({
      campaigns: [{ campaign_id: 'campaign-1', title: 'Solar grid', milestones: false }],
    });
    renderWithProviders(<NotificationSettings />);

    const link = await screen.findByRole('link', { name: 'Solar grid' });
    expect(link).toHaveAttribute('href', '/campaigns/campaign-1');
  });

  it('resets every override and clears the list', async () => {
    api.getMyCommunicationPreferences.mockResolvedValue({
      campaigns: [{ campaign_id: 'campaign-1', title: 'Solar grid', milestones: false }],
    });
    api.resetMyCommunicationPreferences.mockResolvedValue({ removed: 1 });

    renderWithProviders(<NotificationSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(api.resetMyCommunicationPreferences).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Solar grid')).not.toBeInTheDocument());
    expect(
      screen.getByText(/You have not muted anything on an individual campaign yet/)
    ).toBeInTheDocument();
  });

  it('surfaces a reset failure and keeps the list intact', async () => {
    api.getMyCommunicationPreferences.mockResolvedValue({
      campaigns: [{ campaign_id: 'campaign-1', title: 'Solar grid', milestones: false }],
    });
    api.resetMyCommunicationPreferences.mockRejectedValue(new Error('Network error'));

    renderWithProviders(<NotificationSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Network error', 'error'));
    expect(screen.getByText('Solar grid')).toBeInTheDocument();
  });

  it('degrades to the empty state when the override listing fails to load', async () => {
    api.getMyCommunicationPreferences.mockRejectedValue(new Error('boom'));

    renderWithProviders(<NotificationSettings />);

    // The account-level switches must still render even though the new
    // section's own request failed.
    expect(await screen.findByText('Campaign updates')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText(/You have not muted anything on an individual campaign yet/)
      ).toBeInTheDocument()
    );
  });

  it('renders the per-campaign section heading', async () => {
    api.getMyCommunicationPreferences.mockResolvedValue({ campaigns: [] });
    renderWithProviders(<NotificationSettings />);

    expect(await screen.findByRole('heading', { name: SECTION_HEADING })).toBeInTheDocument();
  });
});
