import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import RecurringPledgeForm from './RecurringPledgeForm';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    createSubscription: vi.fn(),
  },
}));

function openForm() {
  render(<RecurringPledgeForm campaignId="campaign-123" asset="XLM" />);
  fireEvent.click(screen.getByRole('button', { name: 'Pledge Monthly' }));
}

describe('RecurringPledgeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the total commitment for the chosen amount and period count', () => {
    openForm();

    fireEvent.change(screen.getByLabelText('Amount per period (XLM)'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText(/Number of periods/), { target: { value: '4' } });

    expect(screen.getByText('100 XLM')).toBeInTheDocument();
  });

  it('keeps the period slider within 2–24', () => {
    openForm();

    const slider = screen.getByLabelText(/Number of periods/);
    expect(slider).toHaveAttribute('min', '2');
    expect(slider).toHaveAttribute('max', '24');
  });

  it('asks for explicit confirmation before locking funds', async () => {
    openForm();

    fireEvent.change(screen.getByLabelText('Amount per period (XLM)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Number of periods/), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Lock Funds' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('6 claimable balances');
    expect(api.createSubscription).not.toHaveBeenCalled();

    api.createSubscription.mockResolvedValue({
      subscriptionId: 'sub-1',
      balanceIds: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
      totalCommitment: 60,
      firstPaymentDate: '2026-09-17T00:00:00.000Z',
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm & Lock Funds' }).slice(-1)[0]);

    await waitFor(() =>
      expect(api.createSubscription).toHaveBeenCalledWith('campaign-123', {
        amountPerPeriod: 10,
        asset: 'XLM',
        periodMonths: 1,
        totalPeriods: 6,
      })
    );
    await screen.findByText(/Recurring pledge active/);
  });

  it('surfaces a rejected pledge without closing the form', async () => {
    api.createSubscription.mockRejectedValue(new Error('Your wallet holds 5 XLM'));
    openForm();

    fireEvent.change(screen.getByLabelText('Amount per period (XLM)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Lock Funds' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm & Lock Funds' }).slice(-1)[0]);

    expect(await screen.findByText('Your wallet holds 5 XLM')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('sends the selected frequency', async () => {
    api.createSubscription.mockResolvedValue({
      subscriptionId: 'sub-2',
      balanceIds: ['b1', 'b2'],
      totalCommitment: 40,
      firstPaymentDate: '2026-11-16T00:00:00.000Z',
    });
    openForm();

    fireEvent.change(screen.getByLabelText('Amount per period (XLM)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText(/Number of periods/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Quarterly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Lock Funds' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm & Lock Funds' }).slice(-1)[0]);

    await waitFor(() =>
      expect(api.createSubscription).toHaveBeenCalledWith(
        'campaign-123',
        expect.objectContaining({ periodMonths: 3, totalPeriods: 2 })
      )
    );
  });

  describe('Keyboard and Screen Reader Accessibility in ConfirmLockModal', () => {
    function openConfirmModal() {
      openForm();
      fireEvent.change(screen.getByLabelText('Amount per period (XLM)'), {
        target: { value: '10' },
      });
      const triggerBtn = screen.getByRole('button', { name: 'Confirm & Lock Funds' });
      triggerBtn.focus();
      fireEvent.click(triggerBtn);
      return triggerBtn;
    }

    it('has role="dialog", aria-modal="true", and aria-labelledby matching the title', () => {
      openConfirmModal();

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-lock-title');

      const title = screen.getByRole('heading', { level: 2 });
      expect(title).toHaveAttribute('id', 'confirm-lock-title');
      expect(title).toHaveTextContent(/Lock 60 XLM now\?/);
    });

    it('renders overlay with role="presentation"', () => {
      openConfirmModal();

      const dialog = screen.getByRole('dialog');
      const overlay = dialog.closest('.modal-overlay');
      expect(overlay).toHaveAttribute('role', 'presentation');
    });

    it('closes on Escape key press', () => {
      openConfirmModal();
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('focuses the first focusable element on mount', () => {
      openConfirmModal();

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      expect(cancelButton).toHaveFocus();
    });

    it('traps focus inside the dialog when tabbing', () => {
      openConfirmModal();

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      const confirmButton = screen
        .getAllByRole('button', { name: 'Confirm & Lock Funds' })
        .slice(-1)[0];

      // On Cancel (first element), Shift+Tab wraps to Confirm (last element)
      cancelButton.focus();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
      expect(confirmButton).toHaveFocus();

      // On Confirm (last element), Tab wraps to Cancel (first element)
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: false });
      expect(cancelButton).toHaveFocus();
    });

    it('restores focus to the triggering button when modal is dismissed', () => {
      const triggerBtn = openConfirmModal();
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(triggerBtn).toHaveFocus();
    });
  });
});
