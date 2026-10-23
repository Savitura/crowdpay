import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import DisasterReliefPanel from '../../components/campaign/DisasterReliefPanel';

vi.mock('../../services/api', () => ({
  api: {
    getDisasterRelief: vi.fn(),
    createDisasterRelief: vi.fn(),
    updateDisasterRelief: vi.fn(),
    submitDisasterRelief: vi.fn(),
    reviewDisasterRelief: vi.fn(),
    revokeDisasterRelief: vi.fn(),
  },
}));

import { api } from '../../services/api';

const VERIFIED_DOSSIER = {
  id: 'dr-1',
  campaign_id: 'campaign-1',
  incident_name: 'Lower Niger Basin Flood Response',
  disaster_type: 'flood',
  severity_level: 'critical',
  affected_region: 'Kogi & Anambra States',
  affected_population: 25000,
  responder_organization: 'Red Crescent Field Unit',
  verification_badge: 'Verified Rapid Response',
  rapid_disbursement_enabled: true,
  status: 'verified',
  evidence_items: [
    {
      id: 'nema_bulletin',
      title: 'NEMA Flood Emergency Bulletin',
      type: 'government_notice',
      url: 'https://nema.gov.example/bulletins/2026-flood-alert',
      issuer: 'NEMA',
    },
  ],
};

describe('DisasterReliefPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for public visitors when the campaign is not in disaster-relief mode', async () => {
    api.getDisasterRelief.mockResolvedValue({ disaster_relief: null });
    const { container } = renderWithProviders(
      <DisasterReliefPanel campaignId="campaign-1" canManage={false} isAdmin={false} />
    );

    await waitFor(() => expect(api.getDisasterRelief).toHaveBeenCalledWith('campaign-1'));
    expect(container.firstChild).toBeNull();
  });

  it('renders verified emergency dossier, rapid disbursement badge, and evidence links for public visitors', async () => {
    api.getDisasterRelief.mockResolvedValue({ disaster_relief: VERIFIED_DOSSIER });
    renderWithProviders(
      <DisasterReliefPanel campaignId="campaign-1" canManage={false} isAdmin={false} />
    );

    expect(await screen.findByText('Lower Niger Basin Flood Response')).toBeInTheDocument();
    expect(screen.getByTestId('disaster-relief-status-badge')).toHaveTextContent(
      'Verified Emergency Response'
    );
    expect(screen.getByTestId('rapid-disbursement-badge')).toHaveTextContent(
      'Rapid Disbursement Enabled'
    );
    expect(screen.getByText(/Verified Rapid Response/)).toBeInTheDocument();

    const evidenceLink = screen.getByRole('link', { name: 'NEMA Flood Emergency Bulletin' });
    expect(evidenceLink).toHaveAttribute(
      'href',
      'https://nema.gov.example/bulletins/2026-flood-alert'
    );
  });

  it('allows a campaign manager to enable disaster-relief mode, save a draft, and submit for rapid verification', async () => {
    api.getDisasterRelief.mockResolvedValue({ disaster_relief: null });
    api.createDisasterRelief.mockResolvedValue({
      disaster_relief: {
        ...VERIFIED_DOSSIER,
        status: 'draft',
        rapid_disbursement_enabled: false,
        verification_badge: null,
      },
    });
    api.submitDisasterRelief.mockResolvedValue({
      disaster_relief: {
        ...VERIFIED_DOSSIER,
        status: 'pending_review',
        rapid_disbursement_enabled: false,
        sla: {
          target_hours: 4,
          due_at: '2026-10-23T12:00:00.000Z',
          remaining_ms: 14400000,
          is_overdue: false,
        },
      },
    });

    renderWithProviders(<DisasterReliefPanel campaignId="campaign-1" canManage isAdmin={false} />);

    const enableBtn = await screen.findByRole('button', {
      name: 'Enable Disaster-Relief Mode',
    });
    await userEvent.click(enableBtn);

    await userEvent.type(
      screen.getByLabelText('Incident Name'),
      'Lower Niger Basin Flood Response'
    );
    await userEvent.selectOptions(screen.getByLabelText('Severity Level'), 'critical');
    await userEvent.type(screen.getByLabelText('Affected Region'), 'Kogi & Anambra States');
    await userEvent.type(
      screen.getByLabelText('24/7 Duty Contact (Internal Only)'),
      'ops@redcrescent.example'
    );
    await userEvent.type(
      screen.getByLabelText('Document / Bulletin Title'),
      'NEMA Flood Emergency Bulletin'
    );
    await userEvent.type(
      screen.getByLabelText('HTTPS URL'),
      'https://nema.gov.example/bulletins/2026-flood-alert'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save Dossier' }));

    await waitFor(() => expect(api.createDisasterRelief).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Disaster-relief dossier saved.')).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: 'Submit for Rapid Verification' });
    await userEvent.click(submitBtn);

    await waitFor(() => expect(api.submitDisasterRelief).toHaveBeenCalledWith('campaign-1'));
    expect(
      await screen.findByText('Submitted to the 4-hour rapid verification queue.')
    ).toBeInTheDocument();
    expect(screen.getByText(/Rapid Verification Target: 4h SLA/)).toBeInTheDocument();
  });

  it('allows an admin to review a pending dossier and surfaces validation errors', async () => {
    api.getDisasterRelief.mockResolvedValue({
      disaster_relief: {
        ...VERIFIED_DOSSIER,
        status: 'pending_review',
        rapid_disbursement_enabled: false,
        sla: {
          target_hours: 4,
          due_at: '2026-10-23T12:00:00.000Z',
          remaining_ms: -60000,
          is_overdue: true,
        },
      },
    });
    api.reviewDisasterRelief
      .mockRejectedValueOnce(new Error('A reviewer note is required when requesting changes'))
      .mockResolvedValueOnce({
        disaster_relief: VERIFIED_DOSSIER,
      });

    renderWithProviders(<DisasterReliefPanel campaignId="campaign-1" canManage isAdmin />);

    expect(await screen.findByText(/SLA Overdue/)).toBeInTheDocument();

    // First attempt: request changes without note -> error surfaced
    await userEvent.click(screen.getByRole('button', { name: 'Request Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A reviewer note is required when requesting changes'
    );

    // Second attempt: approve campaign
    await userEvent.type(screen.getByLabelText('Reviewer Note'), 'Confirmed with NEMA duty desk');
    await userEvent.click(screen.getByRole('button', { name: 'Verify Campaign' }));

    await waitFor(() =>
      expect(api.reviewDisasterRelief).toHaveBeenLastCalledWith('campaign-1', {
        decision: 'verified',
        note: 'Confirmed with NEMA duty desk',
        verification_badge: 'Verified Rapid Response',
        rapid_disbursement_enabled: true,
      })
    );
    expect(screen.getByTestId('disaster-relief-status-badge')).toHaveTextContent(
      'Verified Emergency Response'
    );
  });

  it('allows an admin to revoke a verified dossier with a reason', async () => {
    api.getDisasterRelief.mockResolvedValue({ disaster_relief: VERIFIED_DOSSIER });
    api.revokeDisasterRelief.mockResolvedValue({
      disaster_relief: {
        ...VERIFIED_DOSSIER,
        status: 'revoked',
        rapid_disbursement_enabled: false,
      },
    });

    renderWithProviders(<DisasterReliefPanel campaignId="campaign-1" canManage isAdmin />);

    const reasonInput = await screen.findByLabelText('Revocation Reason');
    await userEvent.type(reasonInput, 'Emergency declaration concluded');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Verification' }));

    await waitFor(() =>
      expect(api.revokeDisasterRelief).toHaveBeenCalledWith('campaign-1', {
        reason: 'Emergency declaration concluded',
      })
    );
    expect(screen.getByTestId('disaster-relief-status-badge')).toHaveTextContent(
      'Verification Revoked'
    );
  });
});
