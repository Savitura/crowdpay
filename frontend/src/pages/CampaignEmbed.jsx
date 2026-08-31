import { useEffect, useState, useCallback } from 'react';
import MilestoneProgressBar, { normalizeWidgetSize } from '../components/MilestoneProgressBar';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = import.meta.env.VITE_API_URL || `${API_BASE_URL}/api`;

function getParentOrigin() {
  const explicit = new URLSearchParams(window.location.search).get('origin');
  if (explicit) return explicit;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return '';
  }
}

export default function CampaignEmbed() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const pathParts = window.location.pathname.split('/');
  const campaignId = pathParts[pathParts.length - 1];
  const params = new URLSearchParams(window.location.search);
  const size = normalizeWidgetSize(params.get('size'));
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const parentOrigin = getParentOrigin();

  const fetchStats = useCallback(async () => {
    if (!campaignId) return;
    try {
      const res = await fetch(`${BASE_URL}/embed/${campaignId}/stats`);
      if (!res.ok) throw new Error('Campaign stats not found');
      const data = await res.json();
      setStats(data);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load campaign');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  useEffect(() => {
    const targetOrigin = parentOrigin || '*';
    let lastHeight = 0;
    let frame = 0;

    const measureHeight = () => {
      const doc = document.documentElement;
      const body = document.body;
      const heights = [doc && doc.scrollHeight, doc && doc.offsetHeight, body && body.scrollHeight];
      return Math.max(0, ...heights.filter(Number.isFinite));
    };

    const notifyHeight = () => {
      const height = measureHeight();
      if (height !== lastHeight) {
        lastHeight = height;
        window.parent.postMessage({ type: 'resize', height }, targetOrigin);
      }
    };

    const scheduleNotify = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(notifyHeight);
    };

    notifyHeight();

    let observer;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(notifyHeight);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }

    window.addEventListener('resize', scheduleNotify);
    window.addEventListener('load', scheduleNotify);

    frame = window.requestAnimationFrame(() => {
      setTimeout(scheduleNotify, 50);
    });

    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', scheduleNotify);
      window.removeEventListener('load', scheduleNotify);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [stats, loading, error, parentOrigin]);

  const isDark = theme === 'dark';
  const bg = isDark ? '#1a202c' : '#ffffff';
  const textColor = isDark ? '#f7fafc' : '#1a202c';
  const textMuted = isDark ? '#a0aec0' : '#718096';
  const borderColor = isDark ? '#2d3748' : '#e2e8f0';

  if (loading) {
    return (
      <div style={{ background: bg, color: textColor, padding: '1rem', fontFamily: 'system-ui, sans-serif', fontSize: '0.85rem' }}>
        Loading campaign progress...
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div style={{ background: bg, color: '#e53e3e', padding: '1rem', fontFamily: 'system-ui, sans-serif', fontSize: '0.85rem' }}>
        {error || 'Campaign not available'}
      </div>
    );
  }

  return (
    <div
      style={{
        background: bg,
        color: textColor,
        border: `1px solid ${borderColor}`,
        borderRadius: '12px',
        padding: size === 'small' ? '0.75rem' : '1rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0, fontSize: size === 'small' ? '0.95rem' : '1.1rem', fontWeight: 700, lineHeight: 1.25 }}>
          {stats.title}
        </h3>
        <span
          style={{
            fontSize: '0.7rem',
            padding: '0.15rem 0.5rem',
            borderRadius: '999px',
            background: isDark ? '#2b6cb0' : '#ebf8ff',
            color: isDark ? '#ebf8ff' : '#2b6cb0',
            fontWeight: 600,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          {stats.status}
        </span>
      </div>

      {size !== 'small' && stats.description && (
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.82rem', color: textMuted, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {stats.description}
        </p>
      )}

      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.3rem', fontWeight: 600 }}>
          <span>
            {Number(stats.raised_amount).toLocaleString()} / {Number(stats.target_amount).toLocaleString()} {stats.asset_type}
          </span>
          <span style={{ color: textMuted }}>{stats.progress_percentage}%</span>
        </div>
        <div style={{ height: '8px', background: borderColor, borderRadius: '99px', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${Math.min(100, stats.progress_percentage)}%`,
              background: '#7c3aed',
              borderRadius: '99px',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: textMuted, marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <span>👥 {stats.backer_count} backers</span>
        {stats.days_remaining !== null && (
          <span>⏳ {stats.days_remaining} days left</span>
        )}
      </div>

      {size === 'large' && stats.milestones?.length > 0 && (
        <MilestoneProgressBar milestones={stats.milestones} size={size} />
      )}

      {size === 'large' && stats.recent_backers?.length > 0 && (
        <div style={{ marginBottom: '0.75rem', borderTop: `1px solid ${borderColor}`, paddingTop: '0.5rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: '0.3rem', color: textMuted }}>Recent Backers</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            {stats.recent_backers.slice(0, 3).map((b, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span>{b.name}</span>
                <span style={{ fontWeight: 600 }}>{Number(b.amount).toLocaleString()} {stats.asset_type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <a
        href={stats.contribution_url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'block',
          textAlign: 'center',
          background: '#7c3aed',
          color: '#ffffff',
          padding: '0.6rem 1rem',
          borderRadius: '8px',
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: '0.85rem',
        }}
      >
        Contribute Now
      </a>
    </div>
  );
}