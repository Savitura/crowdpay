import { useEffect, useState } from 'react';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = import.meta.env.VITE_API_URL || `${API_BASE_URL}/api`;

export default function CampaignEmbed() {
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isLive, setIsLive] = useState(false);

  // Extract campaign ID from URL path: /embed/campaigns/:id
  const pathParts = window.location.pathname.split('/');
  const campaignId = pathParts[pathParts.length - 1];

  useEffect(() => {
    if (!campaignId) {
      setError('Invalid campaign ID');
      setLoading(false);
      return;
    }

    // Fetch initial campaign data
    fetch(`${BASE_URL}/campaigns/${campaignId}/embed`)
      .then((res) => {
        if (!res.ok) throw new Error('Campaign not found');
        return res.json();
      })
      .then((data) => {
        setCampaign(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load campaign');
        setLoading(false);
      });
  }, [campaignId]);

  // Connect to SSE for live updates
  useEffect(() => {
    if (!campaignId || !campaign) return;
    if (!window.EventSource) return;

    const es = new EventSource(`${BASE_URL}/campaigns/${campaignId}/stream`);

    es.onopen = () => setIsLive(true);

    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.type === 'contribution') {
        setCampaign((prev) => (prev ? { ...prev, raised_amount: msg.raised_amount } : prev));
      }
    };

    es.onerror = () => {
      setIsLive(false);
      es.close();
    };

    return () => {
      es.close();
      setIsLive(false);
    };
  }, [campaignId, campaign]);

  // Auto-resize iframe via postMessage
  useEffect(() => {
    const notifyHeight = () => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'resize', height }, '*');
    };

    notifyHeight();
    const interval = setInterval(notifyHeight, 500);

    return () => clearInterval(interval);
  }, [campaign, loading, error]);

  // Listen for open message from parent
  useEffect(() => {
    const handler = (event) => {
      if (event.data && event.data.type === 'open') {
        // do nothing
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.skeleton} />
        <div style={styles.skeletonShort} />
        <div style={styles.skeletonBar} />
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>{error || 'Campaign not found'}</p>
      </div>
    );
  }

  const progressPct = Math.min(100, campaign.progress_percentage);

  return (
    <div style={styles.container}>
      {isLive && <span style={styles.liveIndicator} title="Live updates active" />}

      <h1 style={styles.title}>{campaign.title}</h1>

      {campaign.description && <p style={styles.description}>{campaign.description}</p>}

      <div style={styles.progressSection}>
        <div style={styles.amounts}>
          <div>
            <span style={styles.raisedAmount}>
              {Number(campaign.raised_amount).toLocaleString()}
            </span>
            <span style={styles.asset}>{campaign.asset_type}</span>
            <span style={styles.label}> raised</span>
          </div>
          <div style={styles.target}>{progressPct.toFixed(1)}%</div>
        </div>

        <div style={styles.progressBar}>
          <div
            style={{
              ...styles.progressFill,
              width: `${progressPct}%`,
            }}
          />
        </div>

        <div style={styles.stats}>
          <span>
            <strong>{campaign.backer_count}</strong> backer{campaign.backer_count !== 1 ? 's' : ''}
          </span>
          <span>
            Goal: <strong>{Number(campaign.target_amount).toLocaleString()}</strong>{' '}
            {campaign.asset_type}
          </span>
          {campaign.days_remaining !== null && campaign.days_remaining !== undefined && (
            <span>
              <strong>{campaign.days_remaining}</strong> day{campaign.days_remaining !== 1 ? 's' : ''} left
            </span>
          )}
        </div>
      </div>

      <a
        href={campaign.contribution_url}
        target="_blank"
        rel="noopener noreferrer"
        style={styles.ctaButton}
        onClick={() => {
          // Notify parent that user clicked (for analytics tracking)
          window.parent.postMessage({ type: 'cta_click', campaignId: campaign.id }, '*');
        }}
      >
        Back this campaign
      </a>
    </div>
  );
}

const styles = {
  container: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: '1rem',
    maxWidth: '600px',
    margin: '0 auto',
    background: 'var(--color-bg)',
    borderRadius: '8px',
    position: 'relative',
  },
  liveIndicator: {
    position: 'absolute',
    top: '12px',
    right: '12px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--color-success-text)',
    display: 'block',
    animation: 'pulse 2s infinite',
  },
  title: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    marginBottom: '0.5rem',
    lineHeight: 1.3,
  },
  description: {
    fontSize: '0.85rem',
    color: 'var(--color-text-secondary)',
    lineHeight: 1.5,
    marginBottom: '1rem',
  },
  progressSection: {
    marginBottom: '1rem',
  },
  amounts: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: '0.5rem',
  },
  raisedAmount: {
    fontSize: '1.25rem',
    fontWeight: 800,
    color: 'var(--color-text-primary)',
  },
  asset: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: 'var(--color-accent)',
    marginLeft: '0.25rem',
  },
  label: {
    fontSize: '0.85rem',
    color: 'var(--color-text-hint)',
  },
  target: {
    fontSize: '0.9rem',
    fontWeight: 700,
    color: 'var(--color-accent)',
  },
  progressBar: {
    background: 'var(--color-surface)',
    borderRadius: '99px',
    height: '8px',
    marginBottom: '0.75rem',
    overflow: 'hidden',
  },
  progressFill: {
    background: 'linear-gradient(90deg, var(--color-accent) 0%, var(--color-accent-light) 100%)',
    height: '100%',
    borderRadius: '99px',
    transition: 'width 0.5s ease',
  },
  stats: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.8rem',
    color: 'var(--color-text-hint)',
  },
  ctaButton: {
    display: 'block',
    width: '100%',
    padding: '0.75rem',
    background: 'var(--color-accent)',
    color: '#fff',
    textAlign: 'center',
    borderRadius: '6px',
    fontWeight: 600,
    fontSize: '0.95rem',
    textDecoration: 'none',
    transition: 'opacity 0.15s',
  },
  skeleton: {
    height: '20px',
    width: '70%',
    background: 'var(--color-border)',
    borderRadius: '4px',
    marginBottom: '0.5rem',
    animation: 'pulse 1.5s infinite',
  },
  skeletonShort: {
    height: '14px',
    width: '90%',
    background: 'var(--color-border)',
    borderRadius: '4px',
    marginBottom: '1rem',
    animation: 'pulse 1.5s infinite',
  },
  skeletonBar: {
    height: '8px',
    width: '100%',
    background: 'var(--color-border)',
    borderRadius: '99px',
    animation: 'pulse 1.5s infinite',
  },
  error: {
    color: 'var(--color-status-error)',
    fontSize: '0.85rem',
    textAlign: 'center',
    padding: '1rem',
  },
};

// Add pulse animation
const styleSheet = document.createElement('style');
styleSheet.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;
document.head.appendChild(styleSheet);
