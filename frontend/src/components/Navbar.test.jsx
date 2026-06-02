import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './Navbar';

const mockNavigate = vi.fn();
const mockLogout = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from '../context/AuthContext';

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>
  );
}

describe('Navbar', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLogout.mockClear();
  });

  it('shows login and sign up when unauthenticated', () => {
    useAuth.mockReturnValue({ user: null, logout: mockLogout });
    renderNavbar();
    expect(screen.getByRole('link', { name: /log in/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign up/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /select language/i })).toBeInTheDocument();
  });

  it('shows start campaign and logout when authenticated', () => {
    useAuth.mockReturnValue({
      user: { name: 'Bola', role: 'creator' },
      logout: mockLogout,
    });
    renderNavbar();
    expect(screen.getByRole('link', { name: /start campaign/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
    expect(screen.getByText('Bola')).toBeInTheDocument();
  });

  it('calls logout and navigates home', async () => {
    useAuth.mockReturnValue({
      user: { name: 'Alice', role: 'contributor' },
      logout: mockLogout,
    });
    const user = userEvent.setup();
    renderNavbar();
    await user.click(screen.getByRole('button', { name: /logout/i }));
    expect(mockLogout).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
