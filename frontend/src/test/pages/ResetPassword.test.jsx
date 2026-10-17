import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import ResetPassword from '../../pages/ResetPassword';
import { renderWithProviders } from '../renderWithProviders';

const apiMocks = vi.hoisted(() => ({
  resetPassword: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('ResetPassword page', () => {
  it('submits the reset password form with a valid token', async () => {
    renderWithProviders(<ResetPassword />, { route: '/reset-password?token=abc123' });

    const passwordInputs = screen.getAllByPlaceholderText(/New password/i);
    fireEvent.change(passwordInputs[0], {
      target: { value: 'Password1' },
    });
    fireEvent.change(passwordInputs[1], {
      target: { value: 'Password1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Reset password/i }));

    await waitFor(() =>
      expect(apiMocks.resetPassword).toHaveBeenCalledWith({
        token: 'abc123',
        password: 'Password1',
      })
    );
  });
});
