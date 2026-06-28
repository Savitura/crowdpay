import React from 'react';
import * as Sentry from '@sentry/react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, eventId: null };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
    Sentry.withScope((scope) => {
      scope.setExtras({ componentStack: info.componentStack });
      const eventId = Sentry.captureException(error);
      this.setState({ eventId });
    });
  }

  handleReportClick = () => {
    if (this.state.eventId) {
      Sentry.showReportDialog({ eventId: this.state.eventId });
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <main style={styles.wrapper}>
          <div style={styles.box}>
            <h1 style={styles.heading}>Something went wrong</h1>
            <p style={styles.sub}>
              An unexpected error occurred. Your data is safe — try reloading the page.
            </p>
            <div style={styles.actions}>
              <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
                Reload page
              </button>
              <button type="button" className="btn-secondary" onClick={this.handleReportClick} style={{ marginTop: '0.75rem' }}>
                Report this issue
              </button>
            </div>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}

const styles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    padding: '2rem 1.25rem',
  },
  box: { maxWidth: '420px', textAlign: 'center' },
  heading: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    marginBottom: '0.75rem',
  },
  sub: {
    color: 'var(--color-text-hint)',
    fontSize: '0.95rem',
    lineHeight: 1.55,
    marginBottom: '1.5rem',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
};
