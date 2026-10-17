import { useEffect, useState } from 'react';
import { api } from '../services/api';

export default function Leaderboard() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getLeaderboard(20)
      .then(setEntries)
      .catch((err) => setError(err.message || 'Could not load the leaderboard'));
  }, []);

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '4rem' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.35rem' }}>
        Contributor leaderboard
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: '1.5rem' }}>
        The backers who have put the most behind CrowdPay campaigns.
      </p>

      {error && <p className="alert alert--error">{error}</p>}
      {!entries && !error && (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading leaderboard…</p>
      )}

      {entries && entries.length === 0 && (
        <p className="alert alert--info">No contributions have been recorded yet.</p>
      )}

      {entries && entries.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-hint)' }}>
                <th style={{ padding: '0.5rem 0.6rem' }}>#</th>
                <th style={{ padding: '0.5rem 0.6rem' }}>Contributor</th>
                <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Contributed</th>
                <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Campaigns</th>
                <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Badges</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.user_id}
                  style={{ borderTop: '1px solid var(--color-border-lighter)' }}
                >
                  <td style={{ padding: '0.6rem', fontWeight: 700 }}>{entry.rank}</td>
                  <td style={{ padding: '0.6rem' }}>{entry.name}</td>
                  <td style={{ padding: '0.6rem', textAlign: 'right' }}>
                    {entry.total_contributed.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td style={{ padding: '0.6rem', textAlign: 'right' }}>
                    {entry.campaigns_backed}
                  </td>
                  <td style={{ padding: '0.6rem', textAlign: 'right' }}>{entry.badge_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
