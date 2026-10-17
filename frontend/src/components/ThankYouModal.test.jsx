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
      />
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
      />
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
      />
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
      />
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
      />
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

  describe('Keyboard and Screen Reader Accessibility', () => {
    it('has role="dialog", aria-modal="true", and aria-labelledby matching the title', () => {
      render(
        <ThankYouModal
          campaignId="camp-1"
          contribution={null}
          onClose={mockOnClose}
          onSent={mockOnSent}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'thank-you-title');

      const title = screen.getByRole('heading', { level: 2 });
      expect(title).toHaveAttribute('id', 'thank-you-title');
      expect(title).toHaveTextContent('Send Bulk Thank You');
    });

    it('renders overlay with role="presentation"', () => {
      const { container } = render(
        <ThankYouModal
          campaignId="camp-1"
          contribution={null}
          onClose={mockOnClose}
          onSent={mockOnSent}
        />
      );

      const overlay = container.querySelector('.modal-overlay');
      expect(overlay).toHaveAttribute('role', 'presentation');
    });

    it('closes on Escape key press', () => {
      render(
        <ThankYouModal
          campaignId="camp-1"
          contribution={null}
          onClose={mockOnClose}
          onSent={mockOnSent}
        />
      );

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('focuses the first focusable element on mount', () => {
      render(
        <ThankYouModal
          campaignId="camp-1"
          contribution={null}
          onClose={mockOnClose}
          onSent={mockOnSent}
        />
      );

      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveFocus();
    });

    it('traps focus inside the dialog when tabbing', () => {
      render(
        <ThankYouModal
          campaignId="camp-1"
          contribution={null}
          onClose={mockOnClose}
          onSent={mockOnSent}
        />
      );

      const textarea = screen.getByRole('textbox');
      const cancelButton = screen.getByRole('button', { name: 'Cancel' });

      // Initially on textarea (first element), pressing Shift+Tab wraps to Cancel (last enabled element)
      textarea.focus();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
      expect(cancelButton).toHaveFocus();

      // From Cancel (last element), pressing Tab wraps to textarea (first element)
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: false });
      expect(textarea).toHaveFocus();
    });

    it('restores focus to the triggering element on unmount', () => {
      const triggerButton = document.createElement('button');
      triggerButton.textContent = 'Open Thank You';
      document.body.appendChild(triggerButton);
      triggerButton.focus();
      expect(triggerButton).toHaveFocus();

      const { unmount } = render(
        <ThankYouModal
          campaignId="camp-1"
          contribution={null}
          onClose={mockOnClose}
          onSent={mockOnSent}
        />
      );

      expect(screen.getByRole('textbox')).toHaveFocus();

      unmount();
      expect(triggerButton).toHaveFocus();
      document.body.removeChild(triggerButton);
    });
  });
});
