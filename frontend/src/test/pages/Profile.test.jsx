import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import Profile from '../../pages/Profile';
import { renderWithProviders } from '../renderWithProviders';

const mockUpdateMyProfile = vi.hoisted(() => vi.fn());

const mockUser = {
  id: 'user1',
  name: 'Alice',
  email: 'alice@example.com',
  created_at: '2024-01-01T00:00:00.000Z',
  wallet_public_key: 'GABCDEF',
  kyc_status: 'verified',
};

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    token: 'token',
    ready: true,
    updateUser: vi.fn(),
  }),
}));

vi.mock('../../services/api', () => ({
  api: {
    getMyBadges: vi.fn().mockResolvedValue([]),
    getMyNftRewards: vi.fn().mockResolvedValue({ rewards: [] }),
    updateMyProfile: mockUpdateMyProfile,
    setup2FA: vi.fn(),
    verify2FA: vi.fn(),
  },
}));

describe('Profile page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders profile fields and submits changes', async () => {
    mockUpdateMyProfile.mockResolvedValue({ id: 'user1', name: 'Alice Updated' });

    renderWithProviders(<Profile />);

    expect(await screen.findByRole('heading', { name: /Your Profile/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Display name/i), {
      target: { value: 'Alice Updated' },
    });
    const form = screen.getByRole('button', { name: /Save changes/i }).closest('form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockUpdateMyProfile).toHaveBeenCalledWith({ name: 'Alice Updated' });
    });

    expect(await screen.findByText(/Profile updated successfully/i)).toBeInTheDocument();
  });
});
