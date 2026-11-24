import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ApiKeysPanel from './ApiKeysPanel';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    rotateApiKey: vi.fn(),
  },
}));

describe('ApiKeysPanel', () => {
  const writeTextMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  });

  it('renders loading state initially and lists API keys on load', async () => {
    const mockKeys = [
      {
        id: 'key-1',
        name: 'Backend Service Key',
        key_prefix: 'cpk_backend123',
        expires_at: null,
        revoked_at: null,
        created_at: '2025-01-01T10:00:00Z',
        last_used_at: '2025-01-02T12:00:00Z',
      },
    ];
    api.listApiKeys.mockResolvedValueOnce(mockKeys);

    render(<ApiKeysPanel />);

    expect(screen.getByText(/loading api keys/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Backend Service Key')).toBeInTheDocument();
    });

    expect(screen.getByText('cpk_backend123')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('displays error message when listing API keys fails', async () => {
    api.listApiKeys.mockRejectedValueOnce(new Error('Could not load API keys'));

    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.getByText('Could not load API keys')).toBeInTheDocument();
    });
  });

  it('handles key creation and copy-once secret display', async () => {
    api.listApiKeys.mockResolvedValue([]);
    api.createApiKey.mockResolvedValueOnce({
      api_key: 'cpk_secret_key_full_987654321',
    });

    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    const createBtn = screen.getByRole('button', { name: /create key/i });
    fireEvent.click(createBtn);

    const nameInput = screen.getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: 'Production Key' } });

    const form = nameInput.closest('form');
    if (form) {
      fireEvent.submit(form);
    }

    await waitFor(() => {
      expect(api.createApiKey).toHaveBeenCalledWith({ name: 'Production Key' });
    });

    await waitFor(() => {
      expect(screen.getByText(/cpk_secret_key_full_987654321/)).toBeInTheDocument();
    });

    const copyBtn = screen.getByRole('button', { name: /copy/i });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledWith('cpk_secret_key_full_987654321');
  });

  it('requires window confirmation before revoking an API key', async () => {
    const mockKeys = [
      {
        id: 'key-to-revoke',
        name: 'Staging Integration',
        key_prefix: 'cpk_stage',
        expires_at: null,
        revoked_at: null,
        created_at: '2025-01-01T10:00:00Z',
      },
    ];
    api.listApiKeys.mockResolvedValue(mockKeys);
    api.deleteApiKey.mockResolvedValueOnce({});

    const confirmSpy = vi.spyOn(window, 'confirm');

    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.getByText('Staging Integration')).toBeInTheDocument();
    });

    const revokeBtn = screen.getByRole('button', { name: /revoke/i });

    // 1. User cancels confirmation dialog
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(revokeBtn);

    expect(confirmSpy).toHaveBeenCalledWith(
      'Revoke this API key? Integrations using it will stop working immediately.'
    );
    expect(api.deleteApiKey).not.toHaveBeenCalled();

    // 2. User confirms revocation
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(revokeBtn);

    expect(api.deleteApiKey).toHaveBeenCalledWith('key-to-revoke');
  });

  it('handles key rotation and displays the newly rotated secret', async () => {
    const mockKeys = [
      {
        id: 'key-to-rotate',
        name: 'Key To Rotate',
        key_prefix: 'cpk_rot123',
        expires_at: null,
        revoked_at: null,
        created_at: '2025-01-01T10:00:00Z',
      },
    ];
    api.listApiKeys.mockResolvedValue(mockKeys);
    api.rotateApiKey.mockResolvedValueOnce({
      api_key: 'cpk_rotated_secret_999',
    });

    render(<ApiKeysPanel />);

    await waitFor(() => {
      expect(screen.getByText('Key To Rotate')).toBeInTheDocument();
    });

    const rotateBtn = screen.getByRole('button', { name: /rotate/i });
    fireEvent.click(rotateBtn);

    await waitFor(() => {
      expect(api.rotateApiKey).toHaveBeenCalledWith('key-to-rotate');
    });

    await waitFor(() => {
      expect(screen.getByText(/cpk_rotated_secret_999/)).toBeInTheDocument();
    });
  });
});
