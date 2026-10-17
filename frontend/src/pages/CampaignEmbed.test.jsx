import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react';
import CampaignEmbed from './CampaignEmbed';

const WIDGET_DATA = {
  id: '123',
  title: 'Test Campaign',
  description: 'A test campaign',
  raised_amount: 5000,
  target_amount: 10000,
  asset_type: 'USDC',
  status: 'active',
  contributor_count: 25,
  progress_percentage: 50,
  days_remaining: 10,
  contribution_url: 'https://example.com/campaigns/123',
  milestones: [
    { id: 'm-1', title: 'Design', release_percentage: 50, sort_order: 0, status: 'released' },
    { id: 'm-2', title: 'Build', release_percentage: 50, sort_order: 1, status: 'pending' },
  ],
  milestone_summary: { total: 2, released: 1, approved: 0, submitted: 0, pending: 1 },
  recent_backers: [{ name: 'Alice', amount: 250 }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CampaignEmbed', () => {
  let resizeObserverMock;
  let postMessageSpy;

  beforeEach(() => {
    let resizeCb = null;
    resizeObserverMock = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
      trigger: () => {
        if (resizeCb) resizeCb();
      },
    };
    globalThis.ResizeObserver = class {
      constructor(cb) {
        resizeCb = () => cb();
      }
      observe(el) {
        resizeObserverMock.observe(el);
      }
      unobserve() {
        resizeObserverMock.unobserve();
      }
      disconnect() {
        resizeObserverMock.disconnect();
      }
    };

    postMessageSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 500,
      configurable: true,
      writable: true,
    });
  });

  function renderEmbed(url) {
    window.history.pushState({}, '', url || '/embed/campaigns/123?origin=http://localhost');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(WIDGET_DATA),
    });
    return render(<CampaignEmbed />);
  }

  it('sends initial height notification using the configured origin', async () => {
    renderEmbed();
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        { type: 'resize', height: 500 },
        'http://localhost'
      );
    });
  });

  it('observes document.documentElement with ResizeObserver', async () => {
    renderEmbed();
    expect(resizeObserverMock.observe).toHaveBeenCalledWith(document.documentElement);
  });

  it('does not send duplicate height notifications when size is unchanged', async () => {
    renderEmbed();
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledTimes(2);
    });
    act(() => {
      resizeObserverMock.trigger();
    });
    expect(postMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('sends a new notification when height actually changes', async () => {
    renderEmbed();
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledTimes(2);
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 999,
      configurable: true,
      writable: true,
    });
    act(() => {
      resizeObserverMock.trigger();
    });
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'resize', height: 999 },
      'http://localhost'
    );
  });

  it('disconnects ResizeObserver on unmount', async () => {
    const { unmount } = renderEmbed();
    unmount();
    expect(resizeObserverMock.disconnect).toHaveBeenCalled();
  });

  it('falls back to document.referrer origin when origin param is absent', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://example.com/some-page',
      configurable: true,
    });
    renderEmbed('/embed/campaigns/123');
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        { type: 'resize', height: expect.any(Number) },
        'https://example.com'
      );
    });
  });

  it('uses wildcard when no origin is available', async () => {
    Object.defineProperty(document, 'referrer', {
      value: '',
      configurable: true,
    });
    renderEmbed('/embed/campaigns/123');
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        { type: 'resize', height: expect.any(Number) },
        '*'
      );
    });
  });

  it('fetches the public compact widget payload for the campaign', async () => {
    renderEmbed();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/campaigns/123/widget');
  });

  it('shows a loading state until the payload arrives', async () => {
    window.history.pushState({}, '', '/embed/campaigns/123');
    globalThis.fetch = vi.fn(() => new Promise(() => {}));

    render(<CampaignEmbed />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading campaign progress');
  });

  it('renders progress, backers, milestones and recent backers on success', async () => {
    renderEmbed('/embed/campaigns/123?size=large');

    expect(await screen.findByText('Test Campaign')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('👥 25 backers')).toBeInTheDocument();
    expect(screen.getByText('⏳ 10 days left')).toBeInTheDocument();
    expect(screen.getByText('Recent Backers')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 released')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contribute Now' })).toHaveAttribute(
      'href',
      'https://example.com/campaigns/123'
    );
  });

  it('does not render a hidden backer amount', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...WIDGET_DATA,
          recent_backers: [{ name: 'Anonymous', amount: null }],
        }),
    });
    window.history.pushState({}, '', '/embed/campaigns/123?size=large');

    render(<CampaignEmbed />);

    expect(await screen.findByText('Anonymous')).toBeInTheDocument();
    expect(screen.queryByText('250')).not.toBeInTheDocument();
  });

  it('prompts the first backer when the campaign has no contributions yet', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...WIDGET_DATA, contributor_count: 0 }),
    });
    window.history.pushState({}, '', '/embed/campaigns/123');

    render(<CampaignEmbed />);

    expect(await screen.findByText('Be the first to back this campaign.')).toBeInTheDocument();
  });

  it('shows a failure state with a retry action', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(WIDGET_DATA) });
    window.history.pushState({}, '', '/embed/campaigns/123');

    render(<CampaignEmbed />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Campaign not found');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Test Campaign')).toBeInTheDocument();
  });
});
