import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';

const mockNavigate = vi.fn();
const mockLogin = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ state: null }),
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('../services/api', () => ({
  api: {
    login: vi.fn(),
  },
}));

import { api } from '../services/api';

describe('Login', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLogin.mockClear();
    api.login.mockReset();
  });

  it('shows validation error for empty fields', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: /log in/i }));
    expect(screen.getByText(/email and password are required/i)).toBeInTheDocument();
    expect(api.login).not.toHaveBeenCalled();
  });

  it('shows validation error for invalid email', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Email'), 'not-email');
    await user.type(screen.getByPlaceholderText('Password'), 'Password1');
    await user.click(screen.getByRole('button', { name: /log in/i }));
    expect(screen.getByText(/valid email/i)).toBeInTheDocument();
  });

  it('calls auth service and redirects on success', async () => {
    api.login.mockResolvedValue({
      token: 'jwt',
      user: { id: '1', email: 'a@b.c', name: 'A', role: 'contributor' },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Email'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('Password'), 'Password1');
    await user.click(screen.getByRole('button', { name: /log in/i }));
    await waitFor(() => {
      expect(api.login).toHaveBeenCalledWith({ email: 'a@b.c', password: 'Password1' });
    });
    expect(mockLogin).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
