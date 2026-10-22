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
  getCredentialActivity: vi.fn().mockResolvedValue([]),
  sendWebhookTestEvent: vi.fn().mockResolvedValue({
    success: true,
    latency_ms: 45,
    delivery: { response_status: 200, status: 'delivered' },
  }),
  replayWebhookDelivery: vi.fn().mockResolvedValue({ message: 'Replay queued', id: 'del-1' }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('Developer page', () => {
  afterEach(() => {
    vi.clearAllMocks();
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

  it('triggers a webhook test event when clicking Send test event', async () => {
    apiMocks.listWebhooks.mockResolvedValueOnce([
      {
        id: 'wh-test-1',
        url: 'https://example.com/webhook',
        events: ['contribution.received'],
        secret_hint: 'whsec_test…1234',
        created_at: new Date().toISOString(),
      },
    ]);

    renderWithProviders(<Developer />);

    const testBtn = await screen.findByRole('button', { name: /Send test event/i });
    expect(testBtn).toBeInTheDocument();

    fireEvent.click(testBtn);

    await waitFor(() =>
      expect(apiMocks.sendWebhookTestEvent).toHaveBeenCalledWith('wh-test-1', {
        event_type: 'contribution.received',
      })
    );
  });

  it('renders delivery logs with latency and allows inspecting delivery details', async () => {
    apiMocks.listWebhookDeliveries.mockResolvedValueOnce({
      total: 1,
      deliveries: [
        {
          id: 'del-1',
          webhook_id: 'wh-test-1',
          event_type: 'contribution.received',
          status: 'failed',
          response_status: 500,
          latency_ms: 125,
          attempt_count: 1,
          last_error: 'HTTP 500',
          created_at: new Date().toISOString(),
          payload: { test: true, amount: '100.00' },
          webhook_url: 'https://example.com/webhook',
        },
      ],
    });

    renderWithProviders(<Developer />);

    expect(await screen.findByText('contribution.received')).toBeInTheDocument();
    expect(await screen.findByText('125 ms')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();

    // Inspect delivery details
    const inspectBtn = screen.getByRole('button', { name: /Inspect/i });
    fireEvent.click(inspectBtn);

    expect(await screen.findByText(/Delivery Details/i)).toBeInTheDocument();
    expect(await screen.findByText(/100\.00/)).toBeInTheDocument();

    // Replay failed delivery
    const replayBtn = screen.getByRole('button', { name: /Replay Delivery/i });
    fireEvent.click(replayBtn);

    await waitFor(() => expect(apiMocks.replayWebhookDelivery).toHaveBeenCalledWith('del-1'));
  });
});
