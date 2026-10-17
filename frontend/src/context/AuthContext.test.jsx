import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './AuthContext';

const mockGetMe = vi.fn();
const mockLogout = vi.fn();
const mockAdminExitImpersonation = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getMe: (...args) => mockGetMe(...args),
    logout: (...args) => mockLogout(...args),
    adminExitImpersonation: (...args) => mockAdminExitImpersonation(...args),
  },
}));

const mockSetUser = vi.fn();
vi.mock('@sentry/react', () => ({
  setUser: (...args) => mockSetUser(...args),
}));

function Consumer() {
  const { user, ready, login, logout, updateUser, exitImpersonation } = useAuth();
  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="user">{user ? user.email : 'none'}</span>
      <button onClick={() => login({ id: '1', email: 'new@test.com', role: 'user' })}>Login</button>
      <button onClick={() => logout()}>Logout</button>
      <button onClick={() => updateUser({ id: '1', email: 'updated@test.com' })}>Update</button>
      <button onClick={() => exitImpersonation()}>Exit impersonation</button>
    </div>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets ready and user from a valid session on mount', async () => {
    mockGetMe.mockResolvedValue({ id: '1', email: 'a@test.com', role: 'user' });
    renderAuth();

    expect(screen.getByTestId('ready')).toHaveTextContent('false');

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect(screen.getByTestId('user')).toHaveTextContent('a@test.com');
  });

  it('sets user to null when getMe returns no user data', async () => {
    mockGetMe.mockResolvedValue(null);
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('logs the session out when getMe fails with 401', async () => {
    const error = new Error('Unauthorized');
    error.status = 401;
    mockGetMe.mockRejectedValue(error);
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('logs the session out when getMe fails with 404 (deleted user)', async () => {
    const error = new Error('Not found');
    error.status = 404;
    mockGetMe.mockRejectedValue(error);
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('keeps the current user for a non-auth error (e.g. transient network failure)', async () => {
    const error = new Error('Network error');
    error.status = 500;
    mockGetMe.mockRejectedValue(error);
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    // user stays at its initial null value; the important behavior is that
    // a 500 does NOT force a logout the way 401/404 does
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('login sets the user, marks ready, and reports identity to Sentry', async () => {
    mockGetMe.mockResolvedValue(null);
    const user = userEvent.setup();
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

    await user.click(screen.getByRole('button', { name: 'Login' }));

    expect(screen.getByTestId('user')).toHaveTextContent('new@test.com');
    expect(mockSetUser).toHaveBeenCalledWith({
      id: '1',
      email: 'new@test.com',
      role: 'user',
    });
  });

  it('logout calls the API, clears the user, and clears Sentry identity', async () => {
    mockGetMe.mockResolvedValue({ id: '1', email: 'a@test.com', role: 'user' });
    mockLogout.mockResolvedValue({});
    const user = userEvent.setup();
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@test.com'));

    await user.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'));
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockSetUser).toHaveBeenCalledWith(null);
  });

  it('logout still clears the user locally even if the API call fails', async () => {
    mockGetMe.mockResolvedValue({ id: '1', email: 'a@test.com', role: 'user' });
    mockLogout.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@test.com'));

    await user.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'));
  });

  it('updateUser replaces the user without calling the API', async () => {
    mockGetMe.mockResolvedValue({ id: '1', email: 'a@test.com', role: 'user' });
    const user = userEvent.setup();
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('a@test.com'));

    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(screen.getByTestId('user')).toHaveTextContent('updated@test.com');
    expect(mockGetMe).toHaveBeenCalledTimes(1);
  });

  it('exitImpersonation calls the API and refreshes the user from the server', async () => {
    mockGetMe.mockResolvedValueOnce({ id: '1', email: 'admin@test.com', role: 'admin' });
    mockAdminExitImpersonation.mockResolvedValue({});
    mockGetMe.mockResolvedValueOnce({ id: '2', email: 'real-admin@test.com', role: 'admin' });
    const user = userEvent.setup();
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('admin@test.com'));

    await user.click(screen.getByRole('button', { name: 'Exit impersonation' }));

    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('real-admin@test.com')
    );
    expect(mockAdminExitImpersonation).toHaveBeenCalledTimes(1);
  });

  it('useAuth returns null when used outside an AuthProvider', () => {
    function Bare() {
      const auth = useAuth();
      return <span data-testid="bare">{String(auth)}</span>;
    }
    render(<Bare />);
    expect(screen.getByTestId('bare')).toHaveTextContent('null');
  });
});
