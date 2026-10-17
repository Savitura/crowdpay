import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import CategoryFollows from '../../components/CategoryFollows';

vi.mock('../../services/api', () => ({
  api: {
    getCategories: vi.fn(),
    getCategoryFollows: vi.fn(),
    followCategory: vi.fn(),
    unfollowCategory: vi.fn(),
  },
}));

vi.mock('../../context/AuthContext', async (importOriginal) => {
  const actual = await importOriginal();
  const stableUser = { id: 'user-1' };
  return { ...actual, useAuth: () => ({ user: stableUser, ready: true }) };
});

import { api } from '../../services/api';

describe('CategoryFollows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading, then the category list with follow toggles', async () => {
    api.getCategories.mockResolvedValue([
      { category: 'arts', follower_count: 2, active_campaigns: 5 },
      { category: 'technology', follower_count: 0, active_campaigns: 1 },
    ]);
    api.getCategoryFollows.mockResolvedValue([{ category: 'arts' }]);

    renderWithProviders(<CategoryFollows />);

    expect(screen.getByText(/Loading categories/i)).toBeInTheDocument();

    expect(await screen.findByText('Arts')).toBeInTheDocument();
    expect(screen.getByText('Technology')).toBeInTheDocument();
    // arts is followed -> Following toggle; technology -> Follow toggle
    const toggles = screen.getAllByRole('button', { name: /Following|Follow/ });
    expect(toggles).toHaveLength(2);
  });

  it('shows the empty state when nothing is followed', async () => {
    api.getCategories.mockResolvedValue([{ category: 'arts' }]);
    api.getCategoryFollows.mockResolvedValue([]);

    renderWithProviders(<CategoryFollows />);

    expect(await screen.findByText(/not following any categories yet/i)).toBeInTheDocument();
  });

  it('follows a category optimistically and reverts on failure', async () => {
    api.getCategories.mockResolvedValue([{ category: 'arts' }]);
    api.getCategoryFollows.mockResolvedValue([]);
    api.followCategory.mockRejectedValue(new Error('Network error'));

    renderWithProviders(<CategoryFollows />);

    const toggle = await screen.findByRole('button', { name: '+ Follow' });
    await userEvent.click(toggle);

    await waitFor(() => expect(api.followCategory).toHaveBeenCalledWith('arts'));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
    // reverted back to unfollowed
    expect(screen.getByRole('button', { name: '+ Follow' })).toBeInTheDocument();
  });

  it('unfollows a followed category', async () => {
    api.getCategories.mockResolvedValue([{ category: 'arts' }]);
    api.getCategoryFollows.mockResolvedValue([{ category: 'arts' }]);
    api.unfollowCategory.mockResolvedValue(undefined);

    renderWithProviders(<CategoryFollows />);

    const toggle = await screen.findByRole('button', { name: '✓ Following' });
    await userEvent.click(toggle);

    await waitFor(() => expect(api.unfollowCategory).toHaveBeenCalledWith('arts'));
  });

  it('shows failure with retry when the list cannot load', async () => {
    api.getCategories.mockImplementation(() => {
      throw new Error('offline');
    });
    api.getCategoryFollows.mockResolvedValue([]);

    renderWithProviders(<CategoryFollows />);

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText(/No categories are available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });
});
