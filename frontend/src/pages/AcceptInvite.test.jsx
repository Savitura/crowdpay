import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AcceptInvite from './AcceptInvite';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

const mockNavigate = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getInvitePreview: vi.fn(),
    acceptInviteByToken: vi.fn(),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const validPreview = {
  campaign_id: 'camp-42',
  campaign_title: 'Clean Water Drive',
  role: 'editor',
  invite_expires_at: '2030-01-01T00:00:00Z',
  expired: false,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/campaigns/route-id/invite/tok123']}>
      <Routes>
        <Route path="/campaigns/:id/invite/:token" element={<AcceptInvite />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AcceptInvite page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAuth.mockReturnValue({ user: { id: 'u1' }, ready: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows loading state while the invite preview loads', () => {
    api.getInvitePreview.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading invitation…')).toBeTruthy();
    expect(api.getInvitePreview).toHaveBeenCalledWith('tok123');
  });

  it('accepts a valid invite and redirects to the campaign', async () => {
    api.getInvitePreview.mockResolvedValue(validPreview);
    api.acceptInviteByToken.mockResolvedValue({});
    renderPage();

    expect(await screen.findByText('Clean Water Drive')).toBeTruthy();
    expect(screen.getByText('Editor')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Accept Invitation' }));

    expect(await screen.findByText('Invitation accepted!')).toBeTruthy();
    expect(api.acceptInviteByToken).toHaveBeenCalledWith('tok123');
    expect(mockNavigate).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mockNavigate).toHaveBeenCalledWith('/campaigns/camp-42');
  });

  it('shows an error when the token is invalid or expired', async () => {
    api.getInvitePreview.mockRejectedValue(new Error('Invitation not found'));
    renderPage();

    expect(await screen.findByText('Invitation unavailable')).toBeTruthy();
    expect(screen.getByText('Invitation not found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept Invitation' })).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('disables the button when the invite has expired', async () => {
    api.getInvitePreview.mockResolvedValue({ ...validPreview, expired: true });
    renderPage();

    const button = await screen.findByRole('button', { name: 'Invitation expired' });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.acceptInviteByToken).not.toHaveBeenCalled();
  });

  it('shows an error and does not redirect when accepting fails', async () => {
    api.getInvitePreview.mockResolvedValue(validPreview);
    api.acceptInviteByToken.mockRejectedValue(new Error('Invite already used'));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));

    expect(await screen.findByText('Invite already used')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('falls back to the route id when preview has no campaign_id', async () => {
    api.getInvitePreview.mockResolvedValue({ ...validPreview, campaign_id: undefined });
    api.acceptInviteByToken.mockResolvedValue({});
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));
    await screen.findByText('Invitation accepted!');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mockNavigate).toHaveBeenCalledWith('/campaigns/route-id');
  });

  it('asks logged-out users to log in or register', async () => {
    useAuth.mockReturnValue({ user: null, ready: true });
    api.getInvitePreview.mockResolvedValue(validPreview);
    renderPage();

    expect(
      await screen.findByText('You must be logged in to accept a campaign invitation.')
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept Invitation' })).toBeNull();
  });
});
