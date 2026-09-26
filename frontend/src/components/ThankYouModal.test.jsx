import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ThankYouModal from './ThankYouModal';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    sendBulkThankYou: vi.fn(),
    sendContributionThankYou: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      const map = {
        'thankYou.bulkTitle': 'Send Bulk Thank You',
        'thankYou.individualTitle': 'Send Thank You to Contributor',
        'thankYou.bulkDescription': 'Thank all contributors',
        'thankYou.individualDescription': `Thank ${options?.name || 'contributor'}`,
        'thankYou.placeholder': 'Write your thank you message...',
        'thankYou.charactersLeft': 'characters left',
        'thankYou.send': 'Send',
        'thankYou.sendError': 'Failed to send thank you message',
        'common.cancel': 'Cancel',
      };
      return map[key] || key;
    },
  }),
}));

describe('ThankYouModal Component', () => {
  const mockOnClose = vi.fn();
  const mockOnSent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders bulk thank you modal when no contribution is provided', () => {
    render(
      <ThankYouModal
        campaignId="camp-1"
        contribution={null}
        onClose={mockOnClose}
        onSent={mockOnSent}
      />,
    );

    expect(screen.getByText('Send Bulk Thank You')).toBeInTheDocument();
    expect(screen.getByText('Thank all contributors')).toBeInTheDocument();
  });

  it('renders individual thank you modal when contribution is provided', () => {
    const contribution = { id: 'contrib-1', display_name: 'Alice' };
    render(
      <ThankYouModal
        campaignId="camp-1"
        contribution={contribution}
        onClose={mockOnClose}
        onSent={mockOnSent}
      />,
    );

    expect(screen.getByText('Send Thank You to Contributor')).toBeInTheDocument();
    expect(screen.getByText('Thank Alice')).toBeInTheDocument();
  });

  it('successfully submits bulk thank you message', async () => {
    api.sendBulkThankYou.mockResolvedValueOnce({});

    render(
      <ThankYouModal
        campaignId="camp-1"
        contribution={null}
        onClose={mockOnClose}
        onSent={mockOnSent}
      />,
    );

    const textarea = screen.getByPlaceholderText('Write your thank you message...');
    fireEvent.change(textarea, { target: { value: 'Thank you everyone!' } });

    const submitButton = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.sendBulkThankYou).toHaveBeenCalledWith('camp-1', 'Thank you everyone!');
      expect(mockOnSent).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('successfully submits individual thank you message', async () => {
    api.sendContributionThankYou.mockResolvedValueOnce({});
    const contribution = { id: 'contrib-1', display_name: 'Alice' };

    render(
      <ThankYouModal
        campaignId="camp-1"
        contribution={contribution}
        onClose={mockOnClose}
        onSent={mockOnSent}
      />,
    );

    const textarea = screen.getByPlaceholderText('Write your thank you message...');
    fireEvent.change(textarea, { target: { value: 'Thank you Alice!' } });

    const submitButton = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.sendContributionThankYou).toHaveBeenCalledWith('contrib-1', 'Thank you Alice!');
      expect(mockOnSent).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('handles API error state when submission fails', async () => {
    api.sendBulkThankYou.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    render(
      <ThankYouModal
        campaignId="camp-1"
        contribution={null}
        onClose={mockOnClose}
        onSent={mockOnSent}
      />,
    );

    const textarea = screen.getByPlaceholderText('Write your thank you message...');
    fireEvent.change(textarea, { target: { value: 'Thank you!' } });

    const submitButton = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Rate limit exceeded')).toBeInTheDocument();
      expect(mockOnSent).not.toHaveBeenCalled();
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });
});
