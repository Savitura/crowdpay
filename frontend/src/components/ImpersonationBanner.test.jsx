import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImpersonationBanner from './ImpersonationBanner';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from '../context/AuthContext';

function mockAuth(user, exitImpersonation = vi.fn().mockResolvedValue()) {
  useAuth.mockReturnValue({ user, exitImpersonation });
  return exitImpersonation;
}

describe('ImpersonationBanner', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useAuth.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when there is no user', () => {
    mockAuth(null);
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a normal (non-impersonated) session', () => {
    mockAuth({ id: 'u1', name: 'Ada' });
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when impersonation is present but inactive', () => {
    mockAuth({ id: 'u1', name: 'Ada', impersonation: { active: false } });
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the banner with the impersonated user name', () => {
    mockAuth({ id: 'u1', name: 'Ada', email: 'ada@example.com', impersonation: { active: true } });
    render(<ImpersonationBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('You are viewing as Ada');
    expect(screen.getByRole('button', { name: 'Exit impersonation' })).toBeEnabled();
  });

  it('falls back to email, then id, when name is missing', () => {
    mockAuth({ id: 'u1', email: 'ada@example.com', impersonation: { active: true } });
    const { unmount } = render(<ImpersonationBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('You are viewing as ada@example.com');
    unmount();

    mockAuth({ id: 'u1', impersonation: { active: true } });
    render(<ImpersonationBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('You are viewing as u1');
  });

  it('exits impersonation and navigates to /admin', async () => {
    const exit = mockAuth({ id: 'u1', name: 'Ada', impersonation: { active: true } });
    render(<ImpersonationBanner />);
    await userEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/admin'));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows progress while exiting', async () => {
    let resolveExit;
    const exit = vi.fn(() => new Promise((resolve) => (resolveExit = resolve)));
    mockAuth({ id: 'u1', name: 'Ada', impersonation: { active: true } }, exit);
    render(<ImpersonationBanner />);
    await userEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));

    const busyButton = await screen.findByRole('button', { name: 'Exiting...' });
    expect(busyButton).toBeDisabled();

    resolveExit();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/admin'));
  });

  it('alerts with the error message and does not navigate when exit fails', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const exit = vi.fn().mockRejectedValue(new Error('session expired'));
    mockAuth({ id: 'u1', name: 'Ada', impersonation: { active: true } }, exit);
    render(<ImpersonationBanner />);
    await userEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('session expired'));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Exit impersonation' })).toBeEnabled();
  });
});
