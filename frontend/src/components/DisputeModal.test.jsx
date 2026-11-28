import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DisputeModal from './DisputeModal';

const mockRaiseDispute = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    raiseDispute: (...args) => mockRaiseDispute(...args),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ token: 'jwt-test-token' }),
}));

const CAMPAIGN = {
  id: 'camp-42',
  title: 'Clean Water Borehole',
};

function renderModal(overrides = {}) {
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  const utils = render(
    <DisputeModal campaign={CAMPAIGN} onClose={onClose} onSubmitted={onSubmitted} {...overrides} />
  );
  return { ...utils, onClose, onSubmitted };
}

describe('DisputeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dialog semantics, campaign title, all reason options, and validation attributes', () => {
    renderModal();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Report a problem')).toBeInTheDocument();
    expect(screen.getByText(/Clean Water Borehole/)).toBeInTheDocument();

    const reasonSelect = screen.getByLabelText('Reason');
    expect(reasonSelect).toBeRequired();
    expect(reasonSelect).toHaveValue('non_delivery');
    expect(screen.getAllByRole('option').map((o) => o.value)).toEqual([
      'non_delivery',
      'misrepresentation',
      'abandoned',
      'other',
    ]);

    const descriptionInput = screen.getByLabelText('Description');
    expect(descriptionInput).toBeRequired();

    const evidenceInput = screen.getByLabelText('Evidence URL (optional)');
    expect(evidenceInput).toHaveAttribute('type', 'url');
    expect(evidenceInput).not.toBeRequired();
  });

  it('does not submit when required description is empty or evidence URL is invalid', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));
    expect(mockRaiseDispute).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Description'), 'No progress updates in three months.');
    await user.type(screen.getByLabelText('Evidence URL (optional)'), 'not-a-valid-url');
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));
    expect(mockRaiseDispute).not.toHaveBeenCalled();
  });

  it('submits trimmed dispute fields without optional evidence_url and closes on success', async () => {
    const user = userEvent.setup();
    mockRaiseDispute.mockResolvedValue({ id: 'disp-1' });
    const { onClose, onSubmitted } = renderModal();

    await user.selectOptions(screen.getByLabelText('Reason'), 'abandoned');
    await user.type(
      screen.getByLabelText('Description'),
      '  Creator stopped replying after funding.  '
    );
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    await waitFor(() =>
      expect(mockRaiseDispute).toHaveBeenCalledWith(
        'camp-42',
        {
          reason: 'abandoned',
          description: 'Creator stopped replying after funding.',
          evidence_url: undefined,
        },
        'jwt-test-token'
      )
    );
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits trimmed evidence_url when provided and disables controls while busy', async () => {
    const user = userEvent.setup();
    let resolveSubmit;
    mockRaiseDispute.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      })
    );
    const { onClose, onSubmitted } = renderModal();

    await user.selectOptions(screen.getByLabelText('Reason'), 'misrepresentation');
    await user.type(screen.getByLabelText('Description'), 'Budget items did not match reality.');
    await user.type(
      screen.getByLabelText('Evidence URL (optional)'),
      '  https://example.com/proof.pdf  '
    );
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect(screen.getByRole('button', { name: 'Submitting...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolveSubmit({ id: 'disp-2' });

    await waitFor(() =>
      expect(mockRaiseDispute).toHaveBeenCalledWith(
        'camp-42',
        {
          reason: 'misrepresentation',
          description: 'Budget items did not match reality.',
          evidence_url: 'https://example.com/proof.pdf',
        },
        'jwt-test-token'
      )
    );
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows contributor-specific message on NOT_A_CONTRIBUTOR error without closing', async () => {
    const user = userEvent.setup();
    const err = new Error('Forbidden');
    err.code = 'NOT_A_CONTRIBUTOR';
    mockRaiseDispute.mockRejectedValue(err);
    const { onClose, onSubmitted } = renderModal();

    await user.type(screen.getByLabelText('Description'), 'Reporting non-delivery.');
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect(
      await screen.findByText('Only contributors who have backed this campaign can raise a dispute')
    ).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows API error message or default fallback on generic submission failure', async () => {
    const user = userEvent.setup();
    mockRaiseDispute.mockRejectedValueOnce(new Error('Dispute already open'));
    const { onClose } = renderModal();

    await user.type(screen.getByLabelText('Description'), 'Campaign abandoned.');
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect(await screen.findByText('Dispute already open')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    mockRaiseDispute.mockRejectedValueOnce({});
    await user.click(screen.getByRole('button', { name: 'Submit dispute' }));

    expect(await screen.findByText('Could not submit dispute')).toBeInTheDocument();
  });

  it('calls onClose when clicking the close or cancel button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
