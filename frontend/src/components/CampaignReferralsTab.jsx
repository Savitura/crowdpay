import React, { useEffect, useState } from 'react';
import { api } from '../services/api';

export default function CampaignReferralsTab({ campaignId, assetType }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!campaignId) return;
    api
      .getCampaignReferralCommissions(campaignId)
      .then(setData)
      .catch((err) =>
        setError(err.status === 404 ? 'not_enabled' : err.message || 'Failed to load referrals')
      );
  }, [campaignId]);

  if (error === 'not_enabled') {
    return (
      <p style={{ color: 'var(--color-text-muted)' }}>
        Referrals are not enabled for this campaign. Turn them on in campaign settings to let
        supporters earn commission on the contributions they bring in.
      </p>
    );
  }
  if (error) return <p style={{ color: 'var(--color-danger)' }}>{error}</p>;
  if (!data) return <p style={{ color: 'var(--color-text-muted)' }}>Loading referrals…</p>;

  const { program, referrers } = data;

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
        {referrers.length} of {program.max_referrers} referrer slots claimed —{' '}
        {program.commission_percentage}% commission per referred contribution.
      </p>

      {referrers.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No one has claimed a referral link yet.</p>
      ) : (
        <div className="campaign-card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                <th style={{ padding: '0.5rem 0.75rem' }}>Referrer</th>
                <th style={{ padding: '0.5rem 0.75rem' }}>Code</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Contributions</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Total referred</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Commission owed</th>
              </tr>
            </thead>
            <tbody>
              {referrers.map((referrer) => (
                <tr
                  key={referrer.referral_link_id}
                  style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                >
                  <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>
                    {referrer.referrer_name}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace' }}>
                    {referrer.code}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                    {referrer.contribution_count}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>
                    {referrer.referred_amount} {assetType}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 600 }}>
                    {referrer.commission_owed} {assetType}
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
