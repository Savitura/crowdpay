import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

const STATUS_LABELS = {
  no_referrals: 'No referrals yet',
  pending: 'Pending payout',
  paid: 'Paid out',
};

export default function ReferralDashboard() {
  const { user, ready } = useAuth();
  const [links, setLinks] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!user) return;
    api
      .getMyReferralLinks()
      .then((data) => setLinks(data.links || []))
      .catch((err) => setError(err.message || 'Could not load your referrals'));
  }, [user]);

  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;

  const totalEarned = (links || []).reduce((sum, link) => sum + Number(link.commission_earned), 0);
  const totalPending = (links || []).reduce((sum, link) => sum + Number(link.commission_owed), 0);

  async function copyUrl(link) {
    try {
      await navigator.clipboard.writeText(link.share_url);
      setCopied(link.code);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>My referrals</h1>
      <p style={{ color: 'var(--color-text-muted)', marginTop: 0 }}>
        Commission is paid to your wallet when the creator withdraws from the campaign.
      </p>

      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '1rem 0 1.5rem' }}>
        <div className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.9rem' }}>
          <strong style={{ fontSize: '1.1rem' }}>{totalEarned.toFixed(7)}</strong>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>
            Commission earned
          </div>
        </div>
        <div className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.9rem' }}>
          <strong style={{ fontSize: '1.1rem' }}>{totalPending.toFixed(7)}</strong>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>
            Awaiting payout
          </div>
        </div>
      </div>

      {links === null ? (
        <p>Loading…</p>
      ) : links.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>
          You have no referral links yet. Open a campaign that offers referrals and claim your link
          from its <strong>Share</strong> page.
        </p>
      ) : (
        <div className="campaign-card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                <th style={{ padding: '0.5rem 0.75rem' }}>Campaign</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Rate</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Contributions</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Referred</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Commission</th>
                <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
                <th style={{ padding: '0.5rem 0.75rem' }}>Link</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr
                  key={link.referral_link_id}
                  style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                >
                  <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>
                    <Link to={`/campaigns/${link.campaign_id}`}>{link.campaign_title}</Link>
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                    {link.commission_percentage}%
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                    {link.contribution_count}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>
                    {link.referred_amount} {link.asset_type}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 600 }}>
                    {link.commission_earned} {link.asset_type}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{STATUS_LABELS[link.status]}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <button type="button" className="btn-secondary" onClick={() => copyUrl(link)}>
                      {copied === link.code ? 'Copied!' : 'Copy'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
