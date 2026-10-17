import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SponsorMatchingPanel from './SponsorMatchingPanel';
import { api } from '../services/api';

const showToast = vi.fn();

vi.mock('../context/ToastContext', () => ({
  useToast: vi.fn(),
}));
vi.mock('../services/api', () => ({
  api: {
    getCampaignMatchingProgress: vi.fn(),
    createSponsorMatchingPledge: vi.fn(),
    completeSponsorMatchingPledge: vi.fn(),
    getMySponsorMatches: vi.fn(),
  },
}));

import { useToast } from '../context/ToastContext';

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';

const ACTIVE_MATCH = {
  id: 'match-1',
  sponsorName: 'Alice',
  matchRatio: 1,
  pledgeAmount: 1000,
  matchedAmount: 250,
  remainingAmount: 750,
  status: 'active',
  contributionCount: 2,
  totalContributed: 250,
  createdAt: '2026-09-01T00:00:00.000Z',
};

function progressWith(matches = [ACTIVE_MATCH]) {
  const totalPledged = matches.reduce((sum, match) => sum + match.pledgeAmount, 0);
  const totalMatched = matches.reduce((sum, match) => sum + match.matchedAmount, 0);
  return {
    campaignId: CAMPAIGN_ID,
    matches,
    totalPledged,
    totalMatched,
    remainingPoolAmount: totalPledged - totalMatched,
    activePoolCount: matches.length,
    exhaustedPoolCount: 0,
    percentageUsed: totalPledged > 0 ? Math.round((totalMatched / totalPledged) * 100) : 0,
  };
}

function renderPanel(props = {}) {
  return render(
    <SponsorMatchingPanel campaignId={CAMPAIGN_ID} campaignStatus="active" user={null} {...props} />
  );
}

describe('SponsorMatchingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToast.mockReturnValue(showToast);
    api.getCampaignMatchingProgress.mockResolvedValue(progressWith());
    api.getMySponsorMatches.mockResolvedValue({ pledges: [] });
  });

  it('shows the empty state when no sponsor has pledged yet', async () => {
    api.getCampaignMatchingProgress.mockResolvedValue(progressWith([]));

    renderPanel();

    expect(
      await screen.findByText('No sponsor is matching contributions yet.')
    ).toBeInTheDocument();
  });

  it('renders live matching progress and sponsor badges', async () => {
    renderPanel();

    expect(await screen.findByText(/25% of pool used/)).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/250 of 1000 matched/)).toBeInTheDocument();
    expect(api.getCampaignMatchingProgress).toHaveBeenCalledWith(CAMPAIGN_ID);
  });

  it('shows a retry affordance when progress fails to load', async () => {
    api.getCampaignMatchingProgress.mockRejectedValueOnce(new Error('Progress unavailable'));

    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('Progress unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.getCampaignMatchingProgress).toHaveBeenCalledTimes(2));
  });

  it('hides the pledge form from signed-out visitors', async () => {
    renderPanel();

    await screen.findByText(/25% of pool used/);

    expect(screen.queryByRole('button', { name: 'Pledge matching funds' })).not.toBeInTheDocument();
    expect(api.getMySponsorMatches).not.toHaveBeenCalled();
  });

  it('hides the pledge form for campaigns that are no longer sponsorable', async () => {
    renderPanel({ user: { id: 'sponsor-1' }, campaignStatus: 'completed' });

    await screen.findByText(/25% of pool used/);

    expect(screen.queryByRole('button', { name: 'Pledge matching funds' })).not.toBeInTheDocument();
  });

  it('validates the pledge amount before calling the API', async () => {
    renderPanel({ user: { id: 'sponsor-1' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Pledge matching funds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }));

    expect(await screen.findByText('Enter a positive pledge amount.')).toBeInTheDocument();
    expect(api.createSponsorMatchingPledge).not.toHaveBeenCalled();
  });

  it('rejects a match ratio outside the supported range', async () => {
    renderPanel({ user: { id: 'sponsor-1' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Pledge matching funds' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pledge amount' }), {
      target: { value: '500' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Match ratio' }), {
      target: { value: '250' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }));

    expect(await screen.findByText('Enter a match ratio between 0 and 100.')).toBeInTheDocument();
    expect(api.createSponsorMatchingPledge).not.toHaveBeenCalled();
  });

  it('creates a pledge and refreshes the progress', async () => {
    api.createSponsorMatchingPledge.mockResolvedValue({ id: 'match-2' });
    renderPanel({ user: { id: 'sponsor-1' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Pledge matching funds' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pledge amount' }), {
      target: { value: '500' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Match ratio' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }));

    await waitFor(() =>
      expect(api.createSponsorMatchingPledge).toHaveBeenCalledWith(CAMPAIGN_ID, {
        match_ratio: 2,
        pledge_amount: '500',
      })
    );
    await waitFor(() => expect(api.getCampaignMatchingProgress).toHaveBeenCalledTimes(2));
    expect(showToast).toHaveBeenCalledWith('Matching pledge created.', 'success');
  });

  it('surfaces a duplicate pledge as a form error', async () => {
    const duplicate = new Error('Sponsor already has an active matching pledge for this campaign');
    duplicate.status = 409;
    api.createSponsorMatchingPledge.mockRejectedValue(duplicate);

    renderPanel({ user: { id: 'sponsor-1' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Pledge matching funds' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pledge amount' }), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }));

    expect(
      await screen.findByText('You already have an active matching pledge for this campaign.')
    ).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('lets a sponsor close a pledge they own', async () => {
    api.getMySponsorMatches.mockResolvedValue({
      pledges: [{ id: 'match-1', campaignId: CAMPAIGN_ID }],
    });
    api.completeSponsorMatchingPledge.mockResolvedValue({ id: 'match-1', status: 'completed' });

    renderPanel({ user: { id: 'sponsor-1' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Close pledge' }));

    await waitFor(() =>
      expect(api.completeSponsorMatchingPledge).toHaveBeenCalledWith(CAMPAIGN_ID, 'match-1')
    );
    expect(showToast).toHaveBeenCalledWith('Matching pledge closed.', 'success');
  });

  it('does not offer to close a pledge owned by another sponsor', async () => {
    api.getMySponsorMatches.mockResolvedValue({
      pledges: [{ id: 'someone-elses-match', campaignId: CAMPAIGN_ID }],
    });

    renderPanel({ user: { id: 'sponsor-1' } });

    await screen.findByText(/25% of pool used/);

    expect(screen.queryByRole('button', { name: 'Close pledge' })).not.toBeInTheDocument();
  });
});
