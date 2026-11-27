import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import BudgetBreakdown from './BudgetBreakdown';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getCampaignBudgets: vi.fn(),
    saveCampaignBudgets: vi.fn(),
  },
}));

describe('BudgetBreakdown component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially and then displays budget items and total', async () => {
    const mockBudgets = [
      { title: 'Equipment', amount: '500', description: 'Hardware' },
      { title: 'Marketing', amount: '500', description: 'Ads' },
    ];
    api.getCampaignBudgets.mockResolvedValueOnce(mockBudgets);

    render(<BudgetBreakdown campaignId="c-1" targetAmount={1000} />);

    expect(screen.getByText('Loading budgets...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('Loading budgets...')).not.toBeInTheDocument();
    });

    expect(api.getCampaignBudgets).toHaveBeenCalledWith('c-1');
    expect(screen.getByDisplayValue('Equipment')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Marketing')).toBeInTheDocument();
    expect(screen.getByText(/Total:\s*1000\s*\/\s*1000/)).toBeInTheDocument();
  });

  it('handles empty budget array from API by initializing an empty budget line', async () => {
    api.getCampaignBudgets.mockResolvedValueOnce([]);

    render(<BudgetBreakdown campaignId="c-1" targetAmount={500} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading budgets...')).not.toBeInTheDocument();
    });

    const categoryInput = screen.getByPlaceholderText('Category (e.g., Equipment)');
    const amountInput = screen.getByPlaceholderText('Amount');

    expect(categoryInput).toHaveValue('');
    expect(amountInput).toHaveValue(null);
    expect(screen.getByText(/Total:\s*0\s*\/\s*500/)).toBeInTheDocument();
  });

  it('allows adding and removing budget items and updates total', async () => {
    api.getCampaignBudgets.mockResolvedValueOnce([
      { title: 'Design', amount: '200', description: '' },
    ]);

    render(<BudgetBreakdown campaignId="c-1" targetAmount={500} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Design')).toBeInTheDocument();
    });

    // Add new item
    const addButton = screen.getByRole('button', { name: '+ Add Item' });
    fireEvent.click(addButton);

    const categoryInputs = screen.getAllByPlaceholderText('Category (e.g., Equipment)');
    const amountInputs = screen.getAllByPlaceholderText('Amount');
    expect(categoryInputs.length).toBe(2);

    // Edit second item
    fireEvent.change(categoryInputs[1], { target: { value: 'Development' } });
    fireEvent.change(amountInputs[1], { target: { value: '300' } });

    expect(screen.getByText(/Total:\s*500\s*\/\s*500/)).toBeInTheDocument();

    // Remove first item
    const removeButtons = screen.getAllByTitle('Remove');
    fireEvent.click(removeButtons[0]);

    expect(screen.queryByDisplayValue('Design')).not.toBeInTheDocument();
    expect(screen.getByText(/Total:\s*300\s*\/\s*500/)).toBeInTheDocument();
  });

  it('enables save button when total matches target and saves successfully', async () => {
    api.getCampaignBudgets.mockResolvedValueOnce([
      { title: 'Logistics', amount: '1000', description: '' },
    ]);
    api.saveCampaignBudgets.mockResolvedValueOnce({ success: true });

    render(<BudgetBreakdown campaignId="c-1" targetAmount={1000} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Logistics')).toBeInTheDocument();
    });

    const saveBtn = screen.getByRole('button', { name: 'Save Budget' });
    expect(saveBtn).not.toBeDisabled();

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.saveCampaignBudgets).toHaveBeenCalledWith('c-1', [
        { title: 'Logistics', amount: '1000', description: '' },
      ]);
      expect(screen.getByText('Budget breakdown saved successfully')).toBeInTheDocument();
    });
  });

  it('disables save button when budget total does not match target amount', async () => {
    api.getCampaignBudgets.mockResolvedValueOnce([
      { title: 'Hosting', amount: '300', description: '' },
    ]);

    render(<BudgetBreakdown campaignId="c-1" targetAmount={500} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Hosting')).toBeInTheDocument();
    });

    const saveBtn = screen.getByRole('button', { name: 'Save Budget' });
    expect(saveBtn).toBeDisabled();
  });

  it('renders disabled state when disabled prop is true', async () => {
    api.getCampaignBudgets.mockResolvedValueOnce([
      { title: 'Operations', amount: '500', description: '' },
    ]);

    render(<BudgetBreakdown campaignId="c-1" targetAmount={500} disabled={true} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Operations')).toBeDisabled();
    });

    expect(screen.getByPlaceholderText('Amount')).toBeDisabled();
    expect(screen.getByTitle('Remove')).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Add Item' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Budget' })).toBeDisabled();
  });
});
