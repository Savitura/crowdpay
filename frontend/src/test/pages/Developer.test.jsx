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
  getCredentialActivity: vi.fn().mockResolvedValue([]),
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

  it('aborts in-flight API and OpenAPI spec requests on unmount', () => {
    sessionStorage.clear();
    const fetchSignals = [];

    global.fetch = vi.fn().mockImplementation((_url, options = {}) => {
      fetchSignals.push(options.signal);
      return new Promise(() => {});
    });

    apiMocks.listApiKeys.mockReturnValue(new Promise(() => {}));
    apiMocks.listWebhooks.mockReturnValue(new Promise(() => {}));
    apiMocks.listWebhookDeliveries.mockReturnValue(new Promise(() => {}));
    apiMocks.getCredentialActivity.mockReturnValue(new Promise(() => {}));

    const { unmount } = renderWithProviders(<Developer />);

    const apiSignal = apiMocks.listApiKeys.mock.calls.at(-1)?.[0]?.signal;
    expect(apiSignal).toBeInstanceOf(globalThis.AbortSignal);
    expect(apiSignal.aborted).toBe(false);

    expect(fetchSignals[0]).toBeInstanceOf(globalThis.AbortSignal);
    expect(fetchSignals[0].aborted).toBe(false);

    unmount();

    expect(apiSignal.aborted).toBe(true);
    expect(fetchSignals[0].aborted).toBe(true);
  });
});
