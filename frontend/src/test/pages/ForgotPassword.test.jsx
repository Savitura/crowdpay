import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import ForgotPassword from '../../pages/ForgotPassword';
import { renderWithProviders } from '../renderWithProviders';

const apiMocks = vi.hoisted(() => ({
  forgotPassword: vi.fn().mockResolvedValue({ message: 'Reset email sent' }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('ForgotPassword page', () => {
  it('submits the forgot password form', async () => {
    renderWithProviders(<ForgotPassword />);

    fireEvent.change(screen.getByPlaceholderText(/Email/i), {
      target: { value: 'test@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send reset link/i }));

    await waitFor(() =>
      expect(apiMocks.forgotPassword).toHaveBeenCalledWith({ email: 'test@example.com' })
    );
    expect(await screen.findByText(/Reset email sent/i)).toBeInTheDocument();
  });
});
