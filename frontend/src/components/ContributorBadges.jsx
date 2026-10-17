import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

export function BadgeChip({ badge }) {
  const title = badge.earned_at
    ? `${badge.description} Earned ${new Date(badge.earned_at).toLocaleDateString()}.`
    : badge.description;

  return (
    <span
      title={title}
      style={{
        fontSize: '0.78rem',
        fontWeight: 600,
        padding: '0.3rem 0.65rem',
        borderRadius: '99px',
        border: '1px solid var(--color-border-lighter)',
        color: badge.earned ? 'var(--color-accent)' : 'var(--color-text-hint)',
        background: badge.earned ? 'var(--color-accent-bg, rgba(99,102,241,0.1))' : 'transparent',
        opacity: badge.earned ? 1 : 0.5,
      }}
    >
      {badge.label}
    </span>
  );
}

export default function ContributorBadges() {
  const [badges, setBadges] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getMyBadges()
      .then(setBadges)
      .catch((err) => setError(err.message || 'Could not load badges'));
  }, []);

  const earnedCount = badges?.filter((badge) => badge.earned).length || 0;

  return (
    <div className="campaign-card" style={{ marginBottom: '2rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>
          Badges {badges && `(${earnedCount}/${badges.length})`}
        </h2>
        <Link
          to="/leaderboard"
          style={{ color: 'var(--color-accent)', fontWeight: 600, fontSize: '0.85rem' }}
        >
          View leaderboard
        </Link>
      </div>

      {error && <p className="alert alert--error">{error}</p>}
      {!badges && !error && <p style={{ color: 'var(--color-text-hint)' }}>Loading badges…</p>}

      {badges && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {badges.map((badge) => (
            <BadgeChip key={badge.id} badge={badge} />
          ))}
        </div>
      )}
    </div>
  );
}
