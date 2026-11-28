import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DisputeResolveModal from './DisputeResolveModal';

const DISPUTE = {
  id: '12345678-aaaa-bbbb-cccc-1234567890ab',
  campaign_title: 'Rural Solar Microgrid',
  reporter_name: 'Ada Lovelace',
  reporter_email: 'ada@example.com',
  creator_name: 'Tunde Bello',
  creator_email: 'tunde@example.com',
  reason: 'non_delivery',
  description: 'Panels were never shipped after milestone deadline.',
  evidence_url: 'https://example.com/evidence/123',
};

const THREAD = [
  {
    id: 'evt-1',
    action: 'dispute_opened',
    created_at: '2026-10-01T12:00:00Z',
  },
  {
    id: 'evt-2',
    action: 'creator_responded',
    created_at: '2026-10-02T15:30:00Z',
  },
];

function renderModal(overrides = {}) {
  const onClose = vi.fn();
  const onResolve = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <DisputeResolveModal
      dispute={DISPUTE}
      thread={THREAD}
      onClose={onClose}
      onResolve={onResolve}
      {...overrides}
    />
  );
  return { ...utils, onClose, onResolve };
}

describe('DisputeResolveModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dispute context, evidence link, and last thread activity', () => {
    renderModal();

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Resolve Dispute #12345678')).toBeInTheDocument();
    expect(screen.getByText('Rural Solar Microgrid')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace (ada@example.com)')).toBeInTheDocument();
    expect(screen.getByText('Tunde Bello (tunde@example.com)')).toBeInTheDocument();
    expect(screen.getByText('non delivery')).toBeInTheDocument();
    expect(
      screen.getByText('Panels were never shipped after milestone deadline.')
    ).toBeInTheDocument();

    const evidenceLink = screen.getByRole('link', { name: DISPUTE.evidence_url });
    expect(evidenceLink).toHaveAttribute('href', DISPUTE.evidence_url);
    expect(evidenceLink).toHaveAttribute('target', '_blank');
    expect(evidenceLink).toHaveAttribute('rel', 'noopener noreferrer');

    expect(screen.getByText(/creator_responded/)).toBeInTheDocument();
  });

  it('disables submit until an outcome is chosen and the note has at least 20 characters', async () => {
    const user = userEvent.setup();
    renderModal();

    const submitBtn = screen.getByRole('button', { name: 'Confirm resolution' });
    expect(submitBtn).toBeDisabled();
    expect(screen.getByText('0 / 20 min characters')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Resolution outcome/), 'release_to_creator');
    expect(submitBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/Resolution note/), 'Too short');
    expect(screen.getByText('9 / 20 min characters')).toBeInTheDocument();
    expect(submitBtn).toBeDisabled();

    await user.type(
      screen.getByLabelText(/Resolution note/),
      ' — verified delivery receipts with carrier.'
    );
    expect(submitBtn).toBeEnabled();
  });

  it('shows inline validation errors when submitted without outcome or with a short note', async () => {
    const user = userEvent.setup();
    const { container, onResolve } = renderModal();
    const form = container.querySelector('form');

    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please select a resolution outcome.'
    );
    expect(onResolve).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText(/Resolution outcome/), 'refund_contributors');
    await user.type(screen.getByLabelText(/Resolution note/), '   short note   ');
    fireEvent.submit(form);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Resolution note must be at least 20 characters.'
    );
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('submits release_to_creator and refund_contributors decisions with trimmed note', async () => {
    const user = userEvent.setup();
    const { onResolve, unmount } = renderModal();

    await user.selectOptions(screen.getByLabelText(/Resolution outcome/), 'release_to_creator');
    await user.type(
      screen.getByLabelText(/Resolution note/),
      '  Verified shipping invoice and beneficiary confirmation.  '
    );
    await user.click(screen.getByRole('button', { name: 'Confirm resolution' }));

    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({
        decision: 'release_to_creator',
        reason: 'Verified shipping invoice and beneficiary confirmation.',
      })
    );
    unmount();

    const second = renderModal();
    await user.selectOptions(screen.getByLabelText(/Resolution outcome/), 'refund_contributors');
    await user.type(
      screen.getByLabelText(/Resolution note/),
      'Creator did not supply proof of purchase before deadline.'
    );
    await user.click(screen.getByRole('button', { name: 'Confirm resolution' }));

    await waitFor(() =>
      expect(second.onResolve).toHaveBeenCalledWith({
        decision: 'refund_contributors',
        reason: 'Creator did not supply proof of purchase before deadline.',
      })
    );
  });

  it('disables controls while resolving and surfaces API errors with fallback', async () => {
    const user = userEvent.setup();
    let rejectFirst;
    const onResolve = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
      )
      .mockRejectedValueOnce({});
    renderModal({ onResolve });

    await user.selectOptions(screen.getByLabelText(/Resolution outcome/), 'refund_contributors');
    await user.type(
      screen.getByLabelText(/Resolution note/),
      'Refund approved after audit of missing deliverables.'
    );
    await user.click(screen.getByRole('button', { name: 'Confirm resolution' }));

    expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    rejectFirst(new Error('Escrow contract unreachable'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Escrow contract unreachable');
    expect(screen.getByRole('button', { name: 'Confirm resolution' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Confirm resolution' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not resolve dispute. Please try again.'
    );
  });

  it('calls onClose when Close or Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
