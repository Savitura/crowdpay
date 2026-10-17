import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import CampaignCommunicationPreferences from '../../components/CampaignCommunicationPreferences';

vi.mock('../../services/api', () => ({
  api: {
    getCampaignCommunicationPreferences: vi.fn(),
    setCampaignCommunicationPreferences: vi.fn(),
    resetCampaignCommunicationPreferences: vi.fn(),
  },
}));

import { api } from '../../services/api';

const ALL_ON = {
  campaign_id: 'campaign-1',
  updates: true,
  milestones: true,
  funding_updates: true,
  messages: true,
  surveys: true,
};

describe('CampaignCommunicationPreferences (#961)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every channel as a checked box when nothing is muted', async () => {
    api.getCampaignCommunicationPreferences.mockResolvedValue(ALL_ON);
    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);

    expect(await screen.findByLabelText('Campaign updates')).toBeChecked();
    expect(screen.getByLabelText('Milestones')).toBeChecked();
    expect(screen.getByLabelText('Funding progress')).toBeChecked();
    expect(screen.getByLabelText('Replies to you')).toBeChecked();
    expect(screen.getByLabelText('Surveys and research')).toBeChecked();
  });

  it('reflects the stored overrides', async () => {
    api.getCampaignCommunicationPreferences.mockResolvedValue({
      ...ALL_ON,
      milestones: false,
      surveys: false,
    });
    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);

    expect(await screen.findByLabelText('Campaign updates')).toBeChecked();
    expect(screen.getByLabelText('Milestones')).not.toBeChecked();
    expect(screen.getByLabelText('Surveys and research')).not.toBeChecked();
  });

  it('shows a loading state before the preferences arrive', () => {
    api.getCampaignCommunicationPreferences.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading your preferences…');
  });

  it('saves a single channel without touching the others', async () => {
    api.getCampaignCommunicationPreferences.mockResolvedValue(ALL_ON);
    api.setCampaignCommunicationPreferences.mockResolvedValue({
      ...ALL_ON,
      milestones: false,
    });

    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);
    const box = await screen.findByLabelText('Milestones');
    await userEvent.click(box);

    await waitFor(() =>
      expect(api.setCampaignCommunicationPreferences).toHaveBeenCalledWith('campaign-1', {
        milestones: false,
      })
    );
    await waitFor(() => expect(screen.getByLabelText('Milestones')).not.toBeChecked());
    // The optimistic update is replaced by the server's full row, so the
    // untouched channels are guaranteed to match what was persisted.
    expect(screen.getByLabelText('Campaign updates')).toBeChecked();
  });

  it('restores the previous value when saving fails', async () => {
    api.getCampaignCommunicationPreferences.mockResolvedValue(ALL_ON);
    api.setCampaignCommunicationPreferences.mockRejectedValue(new Error('Network error'));

    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);
    await userEvent.click(await screen.findByLabelText('Milestones'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    expect(screen.getByLabelText('Milestones')).toBeChecked();
  });

  it('surfaces a load failure', async () => {
    api.getCampaignCommunicationPreferences.mockRejectedValue(new Error('Campaign not found'));
    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Campaign not found');
  });

  it('only offers the reset action once something is actually muted', async () => {
    api.getCampaignCommunicationPreferences.mockResolvedValue(ALL_ON);
    api.setCampaignCommunicationPreferences.mockResolvedValue({ ...ALL_ON, surveys: false });

    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();

    await userEvent.click(await screen.findByLabelText('Surveys and research'));
    const reset = await screen.findByRole('button', { name: 'Reset to default' });

    api.resetCampaignCommunicationPreferences.mockResolvedValue(ALL_ON);
    await userEvent.click(reset);

    await waitFor(() =>
      expect(api.resetCampaignCommunicationPreferences).toHaveBeenCalledWith('campaign-1')
    );
    await waitFor(() => expect(screen.getByLabelText('Surveys and research')).toBeChecked());
  });

  it('gives each checkbox a help description for screen readers', async () => {
    api.getCampaignCommunicationPreferences.mockResolvedValue(ALL_ON);
    renderWithProviders(<CampaignCommunicationPreferences campaignId="campaign-1" />);

    const box = await screen.findByLabelText('Funding progress');
    expect(box).toHaveAccessibleDescription(
      'Updates when the campaign passes 25%, 50%, 75% and 100% funded.'
    );
  });
});
