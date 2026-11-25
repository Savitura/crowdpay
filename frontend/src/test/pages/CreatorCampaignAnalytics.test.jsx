import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreatorCampaignAnalytics from '../../pages/CreatorCampaignAnalytics';
import { renderWithProviders } from '../renderWithProviders';

const authState = vi.hoisted(() => ({
  current: { user: { id: 'creator-1', role: 'creator' }, ready: true },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => authState.current,
}));

const apiMocks = vi.hoisted(() => ({
  getCreatorCampaignAnalytics: vi.fn(),
  exportCreatorCampaignData: vi.fn(),
  exportCampaignReport: vi.fn(),
  getCampaignVelocity: vi.fn(),
  updateVelocityThreshold: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="chart">{children}</div>,
  LineChart: ({ data = [] }) => (
    <ul data-testid="line-chart">
      {data.map((point) => (
        <li key={point.date}>
          {point.date}:{point.amount}
        </li>
      ))}
    </ul>
  ),
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  PieChart: ({ children }) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ data = [] }) => (
    <ul>
      {data.map((point) => (
        <li key={point.name}>
          {point.name}:{point.value}
        </li>
      ))}
    </ul>
  ),
  Cell: () => null,
  BarChart: ({ data = [] }) => (
    <ul data-testid="bar-chart">
      {data.map((point) => (
        <li key={point.name}>
          {point.name}:{point.progress}
        </li>
      ))}
    </ul>
  ),
  Bar: () => null,
}));

const velocity = {
  velocity: { amount_per_hour: 2, amount_per_day: 20 },
  projected_completion_date: null,
  category_comparison: { category_avg_weekly: 40 },
  alerts: { threshold: 1, is_below_threshold: false },
  trends: {
    view_7d: [{ date: '2026-11-20', amount: 10 }],
    view_30d: [
      { date: '2026-10-25', amount: 4 },
      { date: '2026-11-20', amount: 10 },
    ],
  },
};

const analytics = {
  campaign: {
    title: 'Solar Garden',
    raised_amount: 800,
    target_amount: 1000,
    asset_type: 'USDC',
  },
  contributor_retention: { new: 3, returning: 6, total: 9, retention_rate: 66 },
  asset_mix: [
    { asset: 'USDC', total: '700', count: 7 },
    { asset: 'XLM', total: '100', count: 2 },
  ],
  milestones: [
    { title: 'Prototype', progress_pct: 100, percentage: 40, status: 'released' },
    { title: 'Launch', progress_pct: 25, percentage: 60, status: 'pending' },
  ],
};

function renderPage(campaignId = 'camp-1') {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<h1>Login</h1>} />
      <Route path="/dashboard" element={<h1>Dashboard home</h1>} />
      <Route path="/dashboard/analytics/:campaignId" element={<CreatorCampaignAnalytics />} />
    </Routes>,
    { route: `/dashboard/analytics/${campaignId}` }
  );
}

describe('CreatorCampaignAnalytics page', () => {
  beforeEach(() => {
    authState.current = { user: { id: 'creator-1', role: 'creator' }, ready: true };
    vi.clearAllMocks();
    apiMocks.getCreatorCampaignAnalytics.mockResolvedValue(analytics);
    apiMocks.getCampaignVelocity.mockResolvedValue(velocity);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders chart data for the campaign in the route', async () => {
    renderPage('camp-solar');

    expect(await screen.findByRole('heading', { name: 'Solar Garden' })).toBeInTheDocument();
    expect(apiMocks.getCreatorCampaignAnalytics).toHaveBeenCalledWith('camp-solar');
    expect(apiMocks.getCampaignVelocity).toHaveBeenCalledWith('camp-solar');
    expect(screen.getByText('Raised')).toBeInTheDocument();
    expect(screen.getByText('66%')).toBeInTheDocument();

    const pie = screen.getByTestId('pie-chart');
    expect(within(pie).getByText('USDC:700')).toBeInTheDocument();
    expect(within(pie).getByText('XLM:100')).toBeInTheDocument();

    const bars = screen.getByTestId('bar-chart');
    expect(within(bars).getByText('Prototype:100')).toBeInTheDocument();
    expect(within(bars).getByText('Launch:25')).toBeInTheDocument();
    expect(screen.getByText('2026-11-20:10')).toBeInTheDocument();
  });

  it('filters the velocity chart between the 7 day and 30 day ranges', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Solar Garden' });

    expect(screen.getByText('2026-11-20:10')).toBeInTheDocument();
    expect(screen.queryByText('2026-10-25:4')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '30 Days' }));
    expect(screen.getByText('2026-10-25:4')).toBeInTheDocument();
    expect(screen.getByText('2026-11-20:10')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '7 Days' }));
    expect(screen.queryByText('2026-10-25:4')).not.toBeInTheDocument();
  });

  it('shows empty chart states when the campaign has no contributions or milestones', async () => {
    apiMocks.getCreatorCampaignAnalytics.mockResolvedValue({
      campaign: { title: 'Empty Drive', raised_amount: 0, target_amount: 0, asset_type: 'XLM' },
      contributor_retention: { new: 0, returning: 0, total: 0, retention_rate: 0 },
      asset_mix: [],
      milestones: [],
    });
    apiMocks.getCampaignVelocity.mockResolvedValue({
      ...velocity,
      trends: { view_7d: [], view_30d: [] },
    });

    renderPage('camp-empty');

    expect(await screen.findByRole('heading', { name: 'Empty Drive' })).toBeInTheDocument();
    expect(screen.getByText('No contribution data')).toBeInTheDocument();
    expect(screen.getByText('No milestones defined')).toBeInTheDocument();
    expect(screen.getAllByText('0%').length).toBeGreaterThan(0);
    expect(screen.getByTestId('line-chart')).toBeEmptyDOMElement();
  });

  it('loads a different campaign when the route campaign id changes', async () => {
    const view = renderPage('camp-a');
    await screen.findByRole('heading', { name: 'Solar Garden' });
    view.unmount();

    apiMocks.getCreatorCampaignAnalytics.mockResolvedValue({
      ...analytics,
      campaign: { ...analytics.campaign, title: 'Library Fund' },
    });
    renderPage('camp-b');

    expect(await screen.findByRole('heading', { name: 'Library Fund' })).toBeInTheDocument();
    expect(apiMocks.getCreatorCampaignAnalytics).toHaveBeenCalledWith('camp-b');
    expect(apiMocks.getCampaignVelocity).toHaveBeenCalledWith('camp-b');
  });

  it('shows the analytics error returned by the API', async () => {
    apiMocks.getCreatorCampaignAnalytics.mockRejectedValue(new Error('Campaign analytics failed'));

    renderPage();

    expect(await screen.findByText('Campaign analytics failed')).toBeInTheDocument();
    expect(screen.queryByText('Asset Mix')).not.toBeInTheDocument();
  });

  it('redirects visitors who are not signed in as a creator', async () => {
    authState.current = { user: null, ready: true };
    const signedOut = renderPage();
    expect(await screen.findByRole('heading', { name: 'Login' })).toBeInTheDocument();
    signedOut.unmount();

    authState.current = { user: { id: 'backer-1', role: 'contributor' }, ready: true };
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Dashboard home' })).toBeInTheDocument();
  });
});
