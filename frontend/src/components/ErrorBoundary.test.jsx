import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorBoundary from './ErrorBoundary';

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(() => 'evt-123'),
  showReportDialog: vi.fn(),
  setExtras: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  withScope: (cb) => cb({ setExtras: sentry.setExtras }),
  captureException: sentry.captureException,
  showReportDialog: sentry.showReportDialog,
}));

function Bomb({ explode }) {
  if (explode) throw new Error('boom');
  return <p>all good</p>;
}

describe('ErrorBoundary', () => {
  let consoleError;

  beforeEach(() => {
    sentry.captureException.mockClear();
    sentry.showReportDialog.mockClear();
    sentry.setExtras.mockClear();
    // React logs caught render errors; keep test output clean.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb explode={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('shows the fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report this issue' })).toBeInTheDocument();
    expect(screen.queryByText('all good')).not.toBeInTheDocument();
  });

  it('reports the error to Sentry with the component stack', () => {
    render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>
    );
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(sentry.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({ componentStack: expect.any(String) })
    );
  });

  it('opens the Sentry report dialog with the captured event id', async () => {
    render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Report this issue' }));
    expect(sentry.showReportDialog).toHaveBeenCalledWith({ eventId: 'evt-123' });
  });

  it('does not open the report dialog when Sentry returned no event id', async () => {
    sentry.captureException.mockReturnValueOnce(null);
    render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Report this issue' }));
    expect(sentry.showReportDialog).not.toHaveBeenCalled();
  });

  it('reload button reloads the page (the only reset path)', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(
        <ErrorBoundary>
          <Bomb explode />
        </ErrorBoundary>
      );
      await userEvent.click(screen.getByRole('button', { name: 'Reload page' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('stays on the fallback after a rerender (boundary does not self-reset)', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>
    );
    rerender(
      <ErrorBoundary>
        <Bomb explode={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows fresh children when a new boundary instance mounts after a reload', () => {
    const { unmount } = render(
      <ErrorBoundary>
        <Bomb explode />
      </ErrorBoundary>
    );
    unmount();
    render(
      <ErrorBoundary>
        <Bomb explode={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
  });
});
