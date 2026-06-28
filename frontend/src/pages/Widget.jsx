import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = `${API_BASE_URL}/api`;

function isDocumentVisible() {
  return !document.visibilityState || document.visibilityState === 'visible';
}

export default function Widget() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return undefined;

    let stopped = false;
    let intervalId = null;
    let controller = null;

    const load = async () => {
      if (!isDocumentVisible()) return;

      controller?.abort();
      controller = new AbortController();

      try {
        const res = await fetch(`${BASE_URL}/campaigns/${encodeURIComponent(id)}/widget`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(res.status === 404 ? 'Campaign not found' : 'Could not load campaign');
        }
        const nextData = await res.json();
        if (!stopped) {
          setData(nextData);
          setError('');
        }
      } catch (err) {
        if (!stopped && err.name !== 'AbortError') {
          setError(err.message || 'Could not load campaign');
        }
      }
    };

    const start = () => {
      if (intervalId !== null) return;
      load();
      intervalId = window.setInterval(load, 30_000);
    };

    const stop = () => {
      if (intervalId !== null) return;
      window.clearInterval(intervalId);
      intervalId = null;
      controller?.abort();
    };

    const onVisibilityChange = () => {
      if (isDocumentVisible()) start();
      else stop();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    onVisibilityChange();

    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [id]);

  if (error && !data) {
    return (
      <div style={styles.shell}>
        <div style={{ ...styles.card, ...styles.error }}>{error}</div>
      </div>
    );
  }

  if (!data) return null;

  const raisedAmount = Number(data.raised_amount) || 0;
  const targetAmount = Number(data.target_amount) || 0;
  const pct = targetAmount > 0 ? Math.min(100, (raisedAmount / targetAmount) * 100) : 0;
  const contributorCount = Number(data.contributor_count) || 0;
  const daysRemaining = data.days_remaining;
  const campaignUrl = data.contribution_url || `${window.location.origin}/campaigns/${encodeURIComponent(id)}`;

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        <div style={styles.title}>{data.title}</div>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${pct}%` }} />
        </div>
        <div style={styles.meta}>
          {raisedAmount.toLocaleString()} / {targetAmount.toLocaleString()} {data.asset_type}
          {' · '}
          {contributorCount} backer{contributorCount !== 1 ? 's' : ''}
          {daysRemaining !== null && daysRemaining !== undefined && (
            <>
              {' · '}
              {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} left
            </>
          )}
        </div>
        <a
          href={campaignUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          Back this project
        </a>
      </div>
    </div>
  );
}

const styles = {
  shell: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '100vh',
    margin: 0,
    padding: '0.5rem',
    background: 'var(--crowdpay-bg, #fff)',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: 'var(--crowdpay-text, #111827)',
  },
  card: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '120px',
    padding: '0.75rem',
    border: '1px solid var(--crowdpay-border, #e5e5e5)',
    borderRadius: '10px',
    background: 'var(--crowdpay-card, #fff)',
    color: 'var(--crowdpay-text, #111827)',
  },
  title: {
    minWidth: 0,
    marginBottom: '0.45rem',
    color: 'var(--crowdpay-title, #111827)',
    fontSize: '0.95rem',
    fontWeight: 700,
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  progressTrack: {
    height: '8px',
    marginBottom: '0.45rem',
    overflow: 'hidden',
    borderRadius: '99px',
    background: 'var(--crowdpay-track, #f0f0f0)',
  },
  progressFill: {
    height: '100%',
    borderRadius: '99px',
    background: 'var(--crowdpay-accent, #7c3aed)',
    transition: 'width 200ms ease',
  },
  meta: {
    color: 'var(--crowdpay-muted, #555)',
    fontSize: '0.75rem',
    lineHeight: 1.35,
  },
  link: {
    display: 'inline-block',
    marginTop: '0.3rem',
    color: 'var(--crowdpay-accent, #7c3aed)',
    fontSize: '0.75rem',
    fontWeight: 600,
    textDecoration: 'none',
  },
  error: {
    color: '#b91c1c',
    fontSize: '0.85rem',
  },
};
