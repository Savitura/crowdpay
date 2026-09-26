import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ThankYouModal from '../../components/ThankYouModal';
import { api } from '../../services/api';

vi.mock('../../services/api', () => ({
  api: {
    sendBulkThankYou: vi.fn(),
    sendContributionThankYou: vi.fn(),
  },
}));

describe('ThankYouModal', () => {
  const mockOnClose = vi.fn();
  const mockOnSent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders bulk send modal and submits successfully', async () => {
    api.sendBulkThankYou.mockResolvedValueOnce({});

    render(
      <ThankYouModal
        campaignId="camp-1"
        onClose={mockOnClose}
        onSent={mockOnSent}
      />
    );

    expect(screen.getByText('thankYou.bulkTitle')).toBeDefined();

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Thank you all!' } });

    const submitButton = screen.getByRole('button', { name: /thankYou/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.sendBulkThankYou).toHaveBeenCalledWith('camp-1', 'Thank you all!');
      expect(mockOnSent).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('renders individual send modal and submits successfully', async () => {
    api.sendContributionThankYou.mockResolvedValueOnce({});

    const contribution = { id: 'contrib-1', display_name: 'Alice' };

    render(
      <ThankYouModal
        campaignId="camp-1"
        contribution={contribution}
        onClose={mockOnClose}
        onSent={mockOnSent}
      />
    );

    expect(screen.getByText('thankYou.individualTitle')).toBeDefined();

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Thanks Alice!' } });

    const submitButton = screen.getByRole('button', { name: /thankYou/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.sendContributionThankYou).toHaveBeenCalledWith('contrib-1', 'Thanks Alice!');
      expect(mockOnSent).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('handles API error state correctly', async () => {
    api.sendBulkThankYou.mockRejectedValueOnce(new Error('Network failure'));

    render(
      <ThankYouModal
        campaignId="camp-1"
        onClose={mockOnClose}
        onSent={mockOnSent}
      />
    );

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Thank you!' } });

    const submitButton = screen.getByRole('button', { name: /thankYou/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeDefined();
      expect(mockOnSent).not.toHaveBeenCalled();
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });
});
