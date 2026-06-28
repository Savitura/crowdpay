import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import App from './App';
import './i18n';
import './index.css';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  tracesSampleRate: 0.1,
  enabled: !!import.meta.env.VITE_SENTRY_DSN,
  integrations: [Sentry.browserTracingIntegration()],
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Sentry.ErrorBoundary fallback={({ eventId }) => (
        <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', padding: '2rem' }}>
          <div style={{ maxWidth: '420px', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.75rem' }}>Something went wrong</h1>
            <p style={{ color: 'var(--color-text-hint)', fontSize: '0.95rem', lineHeight: 1.55, marginBottom: '1.5rem' }}>
              An unexpected error occurred. Your data is safe — try reloading the page.
            </p>
            <div>
              <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
                Reload page
              </button>
              {eventId && (
                <button type="button" className="btn-secondary" onClick={() => Sentry.showReportDialog({ eventId })} style={{ marginTop: '0.75rem' }}>
                  Report this issue
                </button>
              )}
            </div>
          </div>
        </main>
      )}>
        <App />
      </Sentry.ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);
