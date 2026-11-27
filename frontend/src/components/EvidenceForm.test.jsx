import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import EvidenceForm from './EvidenceForm';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    submitDisputeEvidence: vi.fn(),
  },
}));

describe('EvidenceForm component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders form elements correctly', () => {
    render(<EvidenceForm disputeId="dispute-1" />);

    expect(screen.getByLabelText(/describe your evidence/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/https:\/\/\.\.\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ add url/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit evidence/i })).toBeInTheDocument();
  });

  it('renders cancel button when onClose is provided', () => {
    const handleClose = vi.fn();
    render(<EvidenceForm disputeId="dispute-1" onClose={handleClose} />);

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.click(cancelBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('shows validation error if description text is empty', async () => {
    render(<EvidenceForm disputeId="dispute-1" />);

    const submitBtn = screen.getByRole('button', { name: /submit evidence/i });
    fireEvent.click(submitBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent('Please describe your evidence.');
    expect(api.submitDisputeEvidence).not.toHaveBeenCalled();
  });

  it('allows adding and removing URL attachment fields', () => {
    render(<EvidenceForm disputeId="dispute-1" />);

    const addUrlBtn = screen.getByRole('button', { name: /\+ add url/i });

    // Initially 1 URL input, no remove buttons
    expect(screen.getAllByPlaceholderText(/https:\/\/\.\.\./i)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();

    // Click Add URL
    fireEvent.click(addUrlBtn);

    // Now 2 URL inputs and remove buttons exist
    expect(screen.getAllByPlaceholderText(/https:\/\/\.\.\./i)).toHaveLength(2);
    const removeBtns = screen.getAllByRole('button', { name: /remove/i });
    expect(removeBtns).toHaveLength(2);

    // Remove the first URL field
    fireEvent.click(removeBtns[0]);

    // Back to 1 URL input
    expect(screen.getAllByPlaceholderText(/https:\/\/\.\.\./i)).toHaveLength(1);
  });

  it('submits evidence successfully with trimmed text and valid URLs', async () => {
    api.submitDisputeEvidence.mockResolvedValueOnce({ success: true });
    const handleSubmitted = vi.fn();
    const handleClose = vi.fn();

    render(
      <EvidenceForm disputeId="dispute-100" onSubmitted={handleSubmitted} onClose={handleClose} />
    );

    const textarea = screen.getByLabelText(/describe your evidence/i);
    const urlInputs = screen.getAllByPlaceholderText(/https:\/\/\.\.\./i);

    fireEvent.change(textarea, { target: { value: '   Receipts and documents provided.   ' } });
    fireEvent.change(urlInputs[0], { target: { value: '  https://example.com/doc1.pdf  ' } });

    // Add another URL field but leave it empty to test filtering
    const addUrlBtn = screen.getByRole('button', { name: /\+ add url/i });
    fireEvent.click(addUrlBtn);

    const submitBtn = screen.getByRole('button', { name: /submit evidence/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.submitDisputeEvidence).toHaveBeenCalledWith('dispute-100', {
        text: 'Receipts and documents provided.',
        attachmentUrls: ['https://example.com/doc1.pdf'],
      });
    });

    expect(handleSubmitted).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('handles API submission errors gracefully', async () => {
    api.submitDisputeEvidence.mockRejectedValueOnce(new Error('Server submission error'));

    render(<EvidenceForm disputeId="dispute-1" />);

    const textarea = screen.getByLabelText(/describe your evidence/i);
    fireEvent.change(textarea, { target: { value: 'Valid evidence text' } });

    const submitBtn = screen.getByRole('button', { name: /submit evidence/i });
    fireEvent.click(submitBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent('Server submission error');
  });

  it('disables buttons during active submission', async () => {
    let resolveSubmit;
    api.submitDisputeEvidence.mockImplementation(
      () => new Promise((resolve) => { resolveSubmit = resolve; })
    );

    const handleClose = vi.fn();
    render(<EvidenceForm disputeId="dispute-1" onClose={handleClose} />);

    const textarea = screen.getByLabelText(/describe your evidence/i);
    fireEvent.change(textarea, { target: { value: 'Submitting test' } });

    const submitBtn = screen.getByRole('button', { name: /submit evidence/i });
    const cancelBtn = screen.getByRole('button', { name: /cancel/i });

    fireEvent.click(submitBtn);

    expect(submitBtn).toHaveTextContent('Submitting...');
    expect(submitBtn).toBeDisabled();
    expect(cancelBtn).toBeDisabled();

    resolveSubmit({ success: true });
    await waitFor(() => {
      expect(submitBtn).not.toBeDisabled();
    });
  });
});
