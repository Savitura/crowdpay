import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreatorAnalytics from '../../pages/CreatorAnalytics';
import { renderWithProviders } from '../renderWithProviders';

const authState = vi.hoisted(() => ({
  current: { user: { id: 'creator-1', role: 'creator' }, ready: true },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => authState.current,
}));

const apiMocks = vi.hoisted(() => ({
  getCreatorAnalyticsOverview: vi.fn(),
  getMyCampaigns: vi.fn(),
  getCreatorBenchmarks: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

vi.mock('../../components/MiniLineChart', () => ({
  default: ({ data }) => (
    <div data-testid="velocity-chart">
      {(data || []).map((point) => (
        <span key={point.day}>
          {point.day}:{point.total_amount}
        </span>
      ))}
    </div>
  ),
}));

const overview = {
  total_raised: 1500,
  unique_contributors: 12,
  total_campaigns: 2,
  active_campaigns: 1,
  completed_campaigns: 1,
  expired_campaigns: 0,
  avg_contribution: 75,
  velocity_7d_avg: 8,
  velocity_30d_avg: 21,
  best_performing_campaign: {
    id: 'camp-high',
    title: 'Solar Garden',
    goal_pct: 80,
    raised_amount: 800,
    target_amount: 1000,
    asset_type: 'USDC',
  },
};

const campaigns = {
  data: [
    {
      id: 'camp-low',
      title: 'Library Fund',
      raised_amount: 900,
      target_amount: 3000,
      contributor_count: 4,
      status: 'active',
    },
    {
      id: 'camp-high',
      title: 'Solar Garden',
      raised_amount: 800,
      target_amount: 1000,
      contributor_count: 9,
      status: 'active',
    },
  ],
};

const benchmarks = {
  comparisons: [
    {
      campaign_id: 'camp-high',
      bracket: '1k-5k',
      creator: { goal_pct: 80, time_to_first_contribution_hours: 6, contributor_count: 9 },
      platform: {
        avg_goal_pct: 40,
        avg_time_to_first_contribution_hours: 18,
        avg_contributor_count: 5,
      },
    },
  ],
};

function mockLoaded() {
  apiMocks.getCreatorAnalyticsOverview.mockResolvedValue(overview);
  apiMocks.getMyCampaigns.mockResolvedValue(campaigns);
  apiMocks.getCreatorBenchmarks.mockResolvedValue(benchmarks);
}

describe('CreatorAnalytics page', () => {
  beforeEach(() => {
    authState.current = { user: { id: 'creator-1', role: 'creator' }, ready: true };
    vi.clearAllMocks();
    mockLoaded();
  });

  it('renders overview stats, the velocity chart, and benchmark comparisons', async () => {
    renderWithProviders(<CreatorAnalytics />);

    expect(await screen.findByRole('heading', { name: 'Creator Analytics' })).toBeInTheDocument();
    expect(screen.getByText('Total Raised')).toBeInTheDocument();
    expect(screen.getByText('Unique Contributors')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Best Performing Campaign')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('link', { name: 'Solar Garden' })
        .some((link) => link.getAttribute('href') === '/campaigns/camp-high')
    ).toBe(true);

    const chart = await screen.findByTestId('velocity-chart');
    expect(within(chart).getByText('30d avg:21')).toBeInTheDocument();
    expect(within(chart).getByText('7d avg:8')).toBeInTheDocument();
    expect(screen.getByText('Avg Goal % Reached')).toBeInTheDocument();
    expect(screen.getByText('1k-5k')).toBeInTheDocument();
  });

  it('shows an empty campaign table and an empty velocity chart when there is no activity', async () => {
    apiMocks.getCreatorAnalyticsOverview.mockResolvedValue({
      ...overview,
      velocity_7d_avg: 0,
      velocity_30d_avg: 0,
      best_performing_campaign: null,
    });
    apiMocks.getMyCampaigns.mockResolvedValue({ data: [] });
    apiMocks.getCreatorBenchmarks.mockResolvedValue({ comparisons: [] });

    renderWithProviders(<CreatorAnalytics />);

    expect(await screen.findByRole('heading', { name: 'Creator Analytics' })).toBeInTheDocument();
    expect(screen.queryByText('Campaign Performance')).not.toBeInTheDocument();
    expect(screen.queryByText('Platform Benchmarks')).not.toBeInTheDocument();
    expect(screen.queryByText('Best Performing Campaign')).not.toBeInTheDocument();
    const chart = await screen.findByTestId('velocity-chart');
    expect(chart).toBeEmptyDOMElement();
  });

  it('sorts the campaign table when a metric header is clicked', async () => {
    renderWithProviders(<CreatorAnalytics />);
    await screen.findByText('Campaign Performance');

    const performanceCard = screen.getByText('Campaign Performance').parentElement;
    const titles = () =>
      within(performanceCard)
        .getAllByRole('link')
        .map((link) => link.textContent);
    const header = (name) => within(performanceCard).getByRole('columnheader', { name });

    expect(titles()).toEqual(['Solar Garden', 'Library Fund']);

    await userEvent.click(header(/Raised/));
    expect(titles()[0]).toBe('Library Fund');

    await userEvent.click(header(/^Goal %/));
    expect(titles()[0]).toBe('Solar Garden');

    await userEvent.click(header(/^Goal %/));
    expect(titles()[0]).toBe('Library Fund');
  });

  it('shows the load error and stays on the page', async () => {
    apiMocks.getCreatorAnalyticsOverview.mockRejectedValue(new Error('Analytics unavailable'));

    renderWithProviders(<CreatorAnalytics />);

    expect(await screen.findByText('Analytics unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Campaign Performance')).not.toBeInTheDocument();
  });

  it('renders nothing until auth is ready and redirects other roles', async () => {
    authState.current = { user: null, ready: false };
    const { unmount } = renderWithProviders(<CreatorAnalytics />);
    expect(screen.queryByRole('heading', { name: 'Creator Analytics' })).not.toBeInTheDocument();
    unmount();

    authState.current = { user: null, ready: true };
    const signedOut = renderWithProviders(<CreatorAnalytics />);
    expect(screen.queryByRole('heading', { name: 'Creator Analytics' })).not.toBeInTheDocument();
    signedOut.unmount();

    authState.current = { user: { id: 'backer-1', role: 'contributor' }, ready: true };
    renderWithProviders(<CreatorAnalytics />);
    expect(screen.queryByRole('heading', { name: 'Creator Analytics' })).not.toBeInTheDocument();
  });
});
