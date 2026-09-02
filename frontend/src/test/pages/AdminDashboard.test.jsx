import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminDashboard from '../../pages/AdminDashboard';
import { renderWithProviders } from '../renderWithProviders';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin', role: 'admin', is_admin: true }, ready: true }),
}));

const apiMocks = vi.hoisted(() => ({
  getAdminHealth: vi.fn().mockResolvedValue({
    active_campaigns: 3,
    total_raised: '5000',
    pending_withdrawals: { count: 1, total_value: '200' },
    open_disputes: 0,
    failed_webhook_deliveries: 0,
    stellar: { network: 'Testnet', current_ledger: 12345, base_fee_stroops: 100, horizon_latency_ms: 50 },
    load_time_ms: 12,
    recent_reconciliation_runs: [],
  }),
  getAdminWebhookDeliveries: vi.fn().mockResolvedValue([]),
  getAdminAuditLogs: vi.fn().mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 }),
  exportAdminAuditLogsCsv: vi.fn().mockResolvedValue({ blob: new Blob(['csv']), filename: 'audit.csv' }),
  exportAdminAuditLogsJson: vi.fn().mockResolvedValue({ blob: new Blob(['json']), filename: 'audit.json' }),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

beforeAll(() => {
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  }
});

describe('AdminDashboard page', () => {
  beforeEach(() => {
    apiMocks.getAdminAuditLogs.mockClear();
    apiMocks.getAdminHealth.mockClear();
    apiMocks.getAdminAuditLogs.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
  });

  it('renders admin dashboard heading and platform health data', async () => {
    renderWithProviders(<AdminDashboard />);

    expect(await screen.findByRole('heading', { name: /Admin Dashboard/i })).toBeInTheDocument();
    expect(screen.getByText(/Active campaigns/i)).toBeInTheDocument();
  });

  it('shows Audit Log tab in the navigation', async () => {
    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });
    expect(screen.getByRole('tab', { name: /Audit Log/i })).toBeInTheDocument();
  });

  it('renders audit log viewer with filters and empty state when clicking Audit Log tab', async () => {
    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });

    const auditTab = screen.getByRole('tab', { name: /Audit Log/i });
    await userEvent.click(auditTab);

    await waitFor(() => {
      expect(apiMocks.getAdminAuditLogs).toHaveBeenCalled();
    });

    expect(screen.getByPlaceholderText(/Actor/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Action/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Resource type/i)).toBeInTheDocument();
    expect(screen.getByText(/Export CSV/)).toBeInTheDocument();
    expect(screen.getByText(/Export JSON/)).toBeInTheDocument();
    expect(screen.getByText(/No audit log entries match/i)).toBeInTheDocument();
  });

  it('renders audit log table when data is present', async () => {
    apiMocks.getAdminAuditLogs.mockResolvedValueOnce({
      data: [
        {
          id: 'a1',
          actor_id: 'u1',
          actor_email: 'admin@test.com',
          action: 'refund_issued',
          resource_type: 'refund',
          resource_id: 'ref-1',
          ip_address: '1.2.3.4',
          user_agent: 'test',
          metadata: { amount: 50 },
          created_at: '2026-06-15T12:00:00Z',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });

    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });

    await userEvent.click(screen.getByRole('tab', { name: /Audit Log/i }));

    expect(await screen.findByText('admin@test.com')).toBeInTheDocument();
    expect(screen.getByText('refund_issued')).toBeInTheDocument();
    expect(screen.getByText('refund')).toBeInTheDocument();
    expect(screen.getByText('1 result')).toBeInTheDocument();
  });

  it('calls getAdminAuditLogs with correct filter params', async () => {
    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });

    await userEvent.click(screen.getByRole('tab', { name: /Audit Log/i }));
    await waitFor(() => expect(apiMocks.getAdminAuditLogs).toHaveBeenCalled());

    apiMocks.getAdminAuditLogs.mockClear();

    await userEvent.type(screen.getByPlaceholderText(/Actor/i), 'evil@test.com');

    await waitFor(() => {
      expect(apiMocks.getAdminAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ actor: 'evil@test.com' })
      );
    });
  });

  it('calls exportAdminAuditLogsCsv when Export CSV is clicked', async () => {
    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });

    await userEvent.click(screen.getByRole('tab', { name: /Audit Log/i }));
    await waitFor(() => expect(apiMocks.getAdminAuditLogs).toHaveBeenCalled());

    await userEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => {
      expect(apiMocks.exportAdminAuditLogsCsv).toHaveBeenCalled();
    });
  });

  it('calls exportAdminAuditLogsJson when Export JSON is clicked', async () => {
    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });

    await userEvent.click(screen.getByRole('tab', { name: /Audit Log/i }));
    await waitFor(() => expect(apiMocks.getAdminAuditLogs).toHaveBeenCalled());

    await userEvent.click(screen.getByText('Export JSON'));

    await waitFor(() => {
      expect(apiMocks.exportAdminAuditLogsJson).toHaveBeenCalled();
    });
  });

  it('pagination disables Previous on first page', async () => {
    apiMocks.getAdminAuditLogs.mockResolvedValueOnce({
      data: [{ id: 'a1', actor_id: 'u1', actor_email: 'a@b.com', action: 'login', resource_type: 'user', resource_id: null, ip_address: null, user_agent: null, metadata: {}, created_at: '2026-01-01T00:00:00Z' }],
      total: 100,
      limit: 50,
      offset: 0,
    });

    renderWithProviders(<AdminDashboard />);
    await screen.findByRole('heading', { name: /Admin Dashboard/i });

    await userEvent.click(screen.getByRole('tab', { name: /Audit Log/i }));
    expect(await screen.findByText('100 results')).toBeInTheDocument();

    const prevBtn = screen.getByRole('button', { name: /Previous/i });
    expect(prevBtn).toBeDisabled();
  });
});
