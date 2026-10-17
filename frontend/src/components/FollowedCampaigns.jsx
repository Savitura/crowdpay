import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import CampaignStatusBadge from './CampaignStatusBadge';
import { FOLLOW_PREFERENCES } from './FollowCampaignButton';

function progressPct(campaign) {
  if (!Number(campaign.target_amount)) return 0;
  return Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100);
}

export default function FollowedCampaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getFollowedCampaigns()
      .then(setCampaigns)
      .catch((err) => setError(err.message || 'Could not load followed campaigns'))
      .finally(() => setLoading(false));
  }, []);

  async function togglePreference(campaignId, key, value) {
    setCampaigns((prev) =>
      prev.map((campaign) =>
        campaign.id === campaignId ? { ...campaign, [key]: value } : campaign
      )
    );
    try {
      await api.updateCampaignFollow(campaignId, { [key]: value });
    } catch (err) {
      setCampaigns((prev) =>
        prev.map((campaign) =>
          campaign.id === campaignId ? { ...campaign, [key]: !value } : campaign
        )
      );
      setError(err.message || 'Could not save notification preference');
    }
  }

  async function unfollow(campaignId) {
    const previous = campaigns;
    setCampaigns((prev) => prev.filter((campaign) => campaign.id !== campaignId));
    try {
      await api.unfollowCampaign(campaignId);
    } catch (err) {
      setCampaigns(previous);
      setError(err.message || 'Could not unfollow campaign');
    }
  }

  if (loading) {
    return <p style={{ color: 'var(--color-text-hint)' }}>Loading followed campaigns…</p>;
  }

  if (!campaigns.length) {
    return (
      <div>
        {error && <p className="alert alert--error">{error}</p>}
        <p className="alert alert--info">
          You are not following any campaigns yet. Follow a campaign to get updates without
          contributing.{' '}
          <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
            Browse campaigns
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      {error && <p className="alert alert--error">{error}</p>}
      <div style={{ display: 'grid', gap: '0.85rem' }}>
        {campaigns.map((campaign) => {
          const pct = progressPct(campaign);
          return (
            <article key={campaign.id} className="campaign-card" style={{ minHeight: 'auto' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <Link
                  to={`/campaigns/${campaign.id}`}
                  style={{ color: 'var(--color-accent)', fontWeight: 700, fontSize: '1rem' }}
                >
                  {campaign.title}
                </Link>
                <CampaignStatusBadge status={campaign.status} />
              </div>

              <div style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
                {Number(campaign.raised_amount).toLocaleString()} /{' '}
                {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type} ·{' '}
                {pct.toFixed(1)}%
              </div>
              <div
                style={{
                  height: '8px',
                  marginTop: '0.35rem',
                  borderRadius: '99px',
                  background: 'var(--color-border-lighter)',
                  overflow: 'hidden',
                }}
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: 'var(--color-accent)',
                    borderRadius: '99px',
                  }}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  alignItems: 'center',
                  marginTop: '0.75rem',
                  fontSize: '0.8rem',
                }}
              >
                {FOLLOW_PREFERENCES.map((preference) => (
                  <label
                    key={preference.key}
                    style={{
                      display: 'flex',
                      gap: '0.35rem',
                      alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(campaign[preference.key])}
                      onChange={(e) =>
                        togglePreference(campaign.id, preference.key, e.target.checked)
                      }
                      style={{ width: 'auto', margin: 0 }}
                    />
                    {preference.label}
                  </label>
                ))}
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: '0.78rem', marginLeft: 'auto' }}
                  onClick={() => unfollow(campaign.id)}
                >
                  Unfollow
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
