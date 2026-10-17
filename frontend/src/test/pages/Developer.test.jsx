import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import Developer from '../../pages/Developer';
import { renderWithProviders } from '../renderWithProviders';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user1', role: 'creator' }, ready: true }),
}));

const apiMocks = vi.hoisted(() => ({
  listApiKeys: vi.fn().mockResolvedValue([]),
  listWebhooks: vi.fn().mockResolvedValue([]),
  listWebhookDeliveries: vi.fn().mockResolvedValue([]),
  createApiKey: vi.fn().mockResolvedValue({ api_key: 'new-key' }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('Developer page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the developer page and creates an API key', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        paths: {
          '/users/me': {
            get: {
              summary: 'Get user',
              responses: {},
            },
          },
        },
      }),
    });

    renderWithProviders(<Developer />);

    expect(await screen.findByRole('heading', { name: /API keys/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'Integration' } });
    fireEvent.click(screen.getByRole('button', { name: /Create key/i }));

    await waitFor(() =>
      expect(apiMocks.createApiKey).toHaveBeenCalledWith({
        name: 'Integration',
        scopes: ['read', 'write', 'withdrawals'],
      })
    );
    expect(await screen.findByText(/Copy now:/i)).toBeInTheDocument();
  });
});
