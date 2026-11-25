import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OpsCenter from './OpsCenter';

describe('OpsCenter Component', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders API key authentication prompt when unauthenticated', async () => {
    render(<OpsCenter />);
    expect(await screen.findByText(/Security Gated/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Operations Centre/i })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/Enter key/i)).toBeInTheDocument();
  });

  it('submits API key and displays the telemetry dashboard', async () => {
    const user = userEvent.setup();

    // Mock global fetch
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('/api/ops/health')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              status: 'ok',
              health_score: 95,
              collected_at: new Date().toISOString(),
              data: {
                system_health_score: 95,
                collected_at: new Date().toISOString(),
                horizon: {
                  testnet: { ok: true, latency_ms: 120 },
                  ledger: { staleness_seconds: 2 },
                },
                sse_streams: {
                  active_connections: 4,
                  dropped_count: 0,
                  total_monitored: 4,
                },
                platform_wallet: {
                  balance_xlm: 45.2,
                  pending_transactions_count: 0,
                  estimated_xlm_needed: 5,
                },
              },
            }),
        });
      }
      if (url.includes('/api/ops/incidents')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ incidents: [] }),
        });
      }
      if (url.includes('/api/ops/campaigns/wallet-audit')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              wallets: [
                {
                  campaign_id: 'c-1',
                  campaign_title: 'Eco Clean Ocean',
                  wallet_public_key: 'GBBD472Q6TDQNCA24G2UG4M326T7J62TK2TYWNDSTXT5VBN2O4OXCT3U',
                  campaign_status: 'active',
                  balance_xlm: 10.0,
                  min_required_xlm: 1.5,
                  deficit_xlm: 0,
                  health: 'ok',
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<OpsCenter />);

    const input = await screen.findByPlaceholderText(/Enter key/i);
    await user.type(input, 'test_ops_key');
    await user.click(screen.getByRole('button', { name: /Unlock Operations Centre/i }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /System Health & Operations Centre/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/Horizon Node Health/i)).toBeInTheDocument();
      expect(screen.getByText(/Eco Clean Ocean/i)).toBeInTheDocument();
    });
  });

  it('defaults to sessionStorage and does not persist key in localStorage', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {}, incidents: [], wallets: [] }),
    });

    render(<OpsCenter />);

    const rememberCheckbox = await screen.findByRole('checkbox', {
      name: /Remember key/i,
    });
    expect(rememberCheckbox).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const input = await screen.findByPlaceholderText(/Enter key/i);
    await user.type(input, 'session_only_key');
    await user.click(screen.getByRole('button', { name: /Unlock Operations Centre/i }));

    expect(sessionStorage.getItem('cp_ops_api_key')).toBe('session_only_key');
    expect(localStorage.getItem('cp_ops_api_key')).toBeNull();
  });

  it('shows warning and stores in localStorage when rememberKey is checked', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {}, incidents: [], wallets: [] }),
    });

    render(<OpsCenter />);

    const rememberCheckbox = await screen.findByRole('checkbox', {
      name: /Remember key/i,
    });
    await user.click(rememberCheckbox);
    expect(rememberCheckbox).toBeChecked();

    expect(screen.getByRole('alert')).toHaveTextContent(/Warning.*localStorage.*XSS/i);

    const input = await screen.findByPlaceholderText(/Enter key/i);
    await user.type(input, 'local_persisted_key');
    await user.click(screen.getByRole('button', { name: /Unlock Operations Centre/i }));

    expect(localStorage.getItem('cp_ops_api_key')).toBe('local_persisted_key');
  });

  it('clears stale keys on 401 and 403 unauthorized responses', async () => {
    sessionStorage.setItem('cp_ops_api_key', 'stale_key');
    localStorage.setItem('cp_ops_api_key', 'stale_key');

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    render(<OpsCenter />);

    await waitFor(() => {
      expect(screen.getByText(/Authentication failed: Invalid OPS_API_KEY/i)).toBeInTheDocument();
      expect(sessionStorage.getItem('cp_ops_api_key')).toBeNull();
      expect(localStorage.getItem('cp_ops_api_key')).toBeNull();
    });
  });
});
