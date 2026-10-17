import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';

/**
 * Public creator profile page (#588).
 * Route: /creators/:id
 *
 * Shows all public campaigns, total raised, backer count, follower count,
 * and member-since date. No authentication required.
 */
export default function CreatorProfile() {
  const { id } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    api
      .getCreatorProfile(id)
      .then(setProfile)
      .catch((err) => setError(err.message || 'Could not load profile'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-text-hint)' }}>Loading profile…</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-error)' }}>{error || 'Creator not found'}</p>
      </div>
    );
  }

  const memberYear = new Date(profile.member_since).getFullYear();

  return (
    <div style={{ maxWidth: 860, margin: '2rem auto', padding: '0 1rem' }}>
      {/* Header */}
      <div className="campaign-card" style={{ marginBottom: '1.5rem', padding: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--color-accent), #7c3aed)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '1.5rem',
              fontWeight: 700,
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            {(profile.name || profile.wallet_public_key || '?').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>
              {profile.name || profile.wallet_public_key?.slice(0, 12) + '…'}
            </h1>
            <p
              style={{
                margin: '0.25rem 0 0',
                fontSize: '0.85rem',
                color: 'var(--color-text-hint)',
              }}
            >
              Member since {memberYear}
            </p>
          </div>
        </div>

        {/* Stats row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: '0.75rem',
            marginTop: '1.25rem',
          }}
        >
          {[
            ['Campaigns', profile.stats.total_campaigns],
            ['Total Raised', Number(profile.stats.total_raised).toLocaleString()],
            ['Backers', profile.stats.total_backers],
            ['Followers', profile.stats.follower_count],
          ].map(([label, value]) => (
            <div
              key={label}
              className="campaign-card"
              style={{ minHeight: 'auto', padding: '0.6rem 0.75rem', textAlign: 'center' }}
            >
              <strong style={{ fontSize: '1.15rem', display: 'block' }}>{value}</strong>
              <span style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Campaigns */}
      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Campaigns</h2>
      {profile.campaigns.length === 0 ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No public campaigns yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {profile.campaigns.map((c) => {
            const pct =
              c.target_amount > 0
                ? Math.min(
                    100,
                    Math.round((Number(c.raised_amount) / Number(c.target_amount)) * 100)
                  )
                : 0;
            return (
              <Link
                key={c.id}
                to={`/campaigns/${c.id}`}
                className="campaign-card"
                style={{
                  minHeight: 'auto',
                  padding: '0.9rem 1rem',
                  textDecoration: 'none',
                  display: 'block',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <strong style={{ fontSize: '0.95rem' }}>{c.title}</strong>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.15rem 0.55rem',
                      borderRadius: 99,
                      background:
                        c.status === 'active'
                          ? 'var(--color-success-bg, #d1fae5)'
                          : 'var(--color-hint-bg, #f4f4f5)',
                      color:
                        c.status === 'active'
                          ? 'var(--color-success, #065f46)'
                          : 'var(--color-text-hint)',
                      fontWeight: 600,
                      textTransform: 'capitalize',
                    }}
                  >
                    {c.status}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: '0.5rem',
                    height: 6,
                    background: 'var(--color-border)',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: 'var(--color-accent)',
                      borderRadius: 3,
                      transition: 'width 0.4s ease',
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: '0.35rem',
                    fontSize: '0.8rem',
                    color: 'var(--color-text-hint)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>
                    {Number(c.raised_amount).toLocaleString()} {c.asset_type} raised
                  </span>
                  <span>{pct}% of goal</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
