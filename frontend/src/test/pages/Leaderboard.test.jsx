import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../renderWithProviders';
import Leaderboard from '../../pages/Leaderboard';

vi.mock('../../services/api', () => ({
  api: { getLeaderboard: vi.fn() },
}));

import { api } from '../../services/api';

describe('Leaderboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ranks contributors by amount contributed', async () => {
    api.getLeaderboard.mockResolvedValue([
      {
        rank: 1,
        user_id: 'u1',
        name: 'Ada',
        total_contributed: 900,
        campaigns_backed: 4,
        badge_count: 3,
      },
      {
        rank: 2,
        user_id: 'u2',
        name: 'Grace',
        total_contributed: 400,
        campaigns_backed: 2,
        badge_count: 1,
      },
    ]);

    renderWithProviders(<Leaderboard />);

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 contributors
  });

  it('explains an empty leaderboard', async () => {
    api.getLeaderboard.mockResolvedValue([]);

    renderWithProviders(<Leaderboard />);

    expect(await screen.findByText(/No contributions have been recorded yet/i)).toBeInTheDocument();
  });
});
