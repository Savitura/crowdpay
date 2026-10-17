import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';
import CampaignStatusBadge from './CampaignStatusBadge';
import { BadgeChip } from './ContributorBadges';
import { useToast } from '../context/ToastContext';

function milestoneStatusLabel(status) {
  if (status === 'released') return 'Released';
  if (status === 'approved') return 'Approved';
  if (status === 'pending_review') return 'Awaiting review';
  if (status === 'rejected') return 'Rejected';
  return 'Pending';
}

function milestoneStatusColor(status) {
  if (status === 'released') return 'var(--color-success-text)';
  if (status === 'approved') return 'var(--color-info-text)';
  if (status === 'pending_review') return 'var(--color-warning-text)';
  if (status === 'rejected') return 'var(--color-error-text)';
  return 'var(--color-text-hint)';
}

function BackedCampaignCard({ campaign, onRefundClaimed }) {
  const toast = useToast();
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState('');

  const pct =
    campaign.target_amount > 0
      ? Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100)
      : 0;

  const pendingRefunds = campaign.contributions.filter((c) => c.refund_status === 'pending');
  const processedRefunds = campaign.contributions.filter((c) => c.refund_status === 'processed');
  const isFailed = campaign.status === 'failed';

  async function claimRefund(contributionId) {
    setClaimingId(contributionId);
    setError('');
    try {
      const result = await api.requestContributionRefund(contributionId);
      toast?.(result.message || 'Refund claimed', 'success');
      onRefundClaimed?.();
    } catch (err) {
      setError(err.message || 'Could not claim refund');
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <article className="campaign-card" style={{ minHeight: 'auto' }}>
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
          to={`/campaigns/${campaign.campaign_id}`}
          style={{ color: 'var(--color-accent)', fontWeight: 700, fontSize: '1rem' }}
        >
          {campaign.title}
        </Link>
        <CampaignStatusBadge status={campaign.status} />
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.85rem',
            marginBottom: '0.35rem',
            gap: '0.5rem',
            flexWrap: 'wrap',
          }}
        >
          <span>
            {campaign.raised_amount.toLocaleString()} / {campaign.target_amount.toLocaleString()}{' '}
            {campaign.asset_type} raised
          </span>
          <span style={{ color: 'var(--color-text-hint)' }}>{pct.toFixed(1)}%</span>
        </div>
        <div
          style={{
            height: '8px',
            borderRadius: '99px',
            background: 'var(--color-border-lighter)',
            overflow: 'hidden',
          }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background: 'var(--color-accent)',
              borderRadius: '99px',
              transition: 'width 200ms ease',
            }}
          />
        </div>
      </div>

      <div
        style={{ marginTop: '0.6rem', fontSize: '0.88rem', color: 'var(--color-text-secondary)' }}
      >
        Your contribution:{' '}
        <strong>
          {campaign.contributed_amount.toLocaleString()} {campaign.asset_type}
        </strong>
      </div>

      {campaign.milestones?.length > 0 && (
        <div style={{ marginTop: '0.85rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.4rem' }}>
            Milestones
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.35rem' }}>
            {campaign.milestones.map((milestone) => (
              <li
                key={milestone.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  fontSize: '0.82rem',
                  flexWrap: 'wrap',
                }}
              >
                <span>{milestone.title}</span>
                <span style={{ color: milestoneStatusColor(milestone.status), fontWeight: 600 }}>
                  {milestoneStatusLabel(milestone.status)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isFailed && (
        <div
          style={{
            marginTop: '0.85rem',
            padding: '0.65rem 0.75rem',
            borderRadius: '8px',
            background: 'var(--color-error-bg, #fef2f2)',
            border: '1px solid var(--color-error-border, #fecaca)',
          }}
        >
          <div style={{ fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.35rem' }}>
            Campaign failed — refund status
          </div>
          {processedRefunds.length > 0 && (
            <div style={{ fontSize: '0.82rem', marginBottom: '0.25rem' }}>
              Processed: {processedRefunds.reduce((sum, c) => sum + c.amount, 0).toLocaleString()}{' '}
              {campaign.asset_type}
            </div>
          )}
          {pendingRefunds.length > 0 && (
            <div style={{ fontSize: '0.82rem', color: 'var(--color-warning-text)' }}>
              Pending: {pendingRefunds.reduce((sum, c) => sum + c.amount, 0).toLocaleString()}{' '}
              {campaign.asset_type}
            </div>
          )}
          {pendingRefunds.length > 0 && campaign.escrow_contract_id && (
            <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.35rem' }}>
              {pendingRefunds.map((contribution) => (
                <button
                  key={contribution.id}
                  type="button"
                  className="btn-primary"
                  style={{ fontSize: '0.8rem', alignSelf: 'flex-start' }}
                  disabled={claimingId === contribution.id}
                  onClick={() => claimRefund(contribution.id)}
                >
                  {claimingId === contribution.id
                    ? 'Claiming…'
                    : `Claim refund (${contribution.amount.toLocaleString()} ${contribution.asset})`}
                </button>
              ))}
            </div>
          )}
          {pendingRefunds.length > 0 && !campaign.escrow_contract_id && (
            <p style={{ fontSize: '0.8rem', marginTop: '0.35rem', marginBottom: 0 }}>
              Refund processing is pending platform action.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="alert alert--error" style={{ marginTop: '0.5rem', fontSize: '0.82rem' }}>
          {error}
        </p>
      )}

      <details style={{ marginTop: '0.75rem' }}>
        <summary style={{ fontSize: '0.82rem', color: 'var(--color-accent)', cursor: 'pointer' }}>
          View {campaign.contributions.length} contribution
          {campaign.contributions.length !== 1 ? 's' : ''}
        </summary>
        <ul
          style={{
            listStyle: 'none',
            margin: '0.5rem 0 0',
            padding: 0,
            display: 'grid',
            gap: '0.35rem',
          }}
        >
          {campaign.contributions.map((contribution) => (
            <li key={contribution.id} style={{ fontSize: '0.82rem' }}>
              {contribution.amount.toLocaleString()} {contribution.asset} ·{' '}
              {new Date(contribution.created_at).toLocaleString()}
              {contribution.tx_hash && (
                <>
                  {' · '}
                  <a
                    href={stellarExpertTxUrl(contribution.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    Tx
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function FavoritesSection() {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getFavorites()
      .then(setFavorites)
      .catch(() => setFavorites([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading || favorites.length === 0) return null;

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        Favorites ({favorites.length})
      </div>
      <div
        style={{
          display: 'grid',
          gap: '0.5rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        }}
      >
        {favorites.map((campaign) => (
          <Link
            key={campaign.id}
            to={`/campaigns/${campaign.id}`}
            className="campaign-card"
            style={{ minHeight: 'auto', padding: '0.6rem 0.75rem', color: 'inherit' }}
          >
            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{campaign.title}</div>
            <CampaignStatusBadge status={campaign.status} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function BadgesRow({ badges }) {
  if (!badges?.length) return null;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
      {badges.map((badge) => (
        <BadgeChip key={badge.id} badge={badge} />
      ))}
      <Link
        to="/leaderboard"
        style={{
          alignSelf: 'center',
          color: 'var(--color-accent)',
          fontWeight: 600,
          fontSize: '0.78rem',
        }}
      >
        Leaderboard
      </Link>
    </div>
  );
}

export default function ContributorDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  function load() {
    setLoading(true);
    setError('');
    api
      .getContributorDashboard()
      .then(setData)
      .catch((err) => setError(err.message || 'Could not load contributions'))
      .finally(() => setLoading(false));
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const { blob, filename } = await api.exportContributionsCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast?.(err.message || 'Could not export contributions', 'error');
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return <p style={{ color: 'var(--color-text-hint)' }}>Loading your contributions…</p>;
  }

  if (error) {
    return <p className="alert alert--error">{error}</p>;
  }

  if (!data?.campaigns?.length) {
    return (
      <div>
        <FavoritesSection />
        <p className="alert alert--info">
          You have not backed any campaigns yet.{' '}
          <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
            Browse campaigns
          </Link>
          .
        </p>
      </div>
    );
  }

  const { stats, campaigns } = data;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <div style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>Your portfolio</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <Link
            to="/tax-receipts"
            style={{ fontSize: '0.8rem', color: 'var(--color-accent)', fontWeight: 700 }}
          >
            Tax receipts
          </Link>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            style={{ fontSize: '0.8rem' }}
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.65rem',
          marginBottom: '1.25rem',
        }}
      >
        {[
          ['Total contributed', stats.total_contributed.toLocaleString()],
          ['Campaigns backed', stats.campaigns_backed],
          ['Active campaigns', stats.active_campaigns_backed],
          ['Campaigns completed', stats.campaigns_completed],
          [
            'Avg. contribution',
            stats.avg_contribution.toLocaleString(undefined, { maximumFractionDigits: 2 }),
          ],
          ['Total refunded', stats.total_refunded.toLocaleString()],
        ].map(([label, value]) => (
          <div
            key={label}
            className="campaign-card"
            style={{ minHeight: 'auto', padding: '0.75rem' }}
          >
            <strong style={{ fontSize: '1.1rem' }}>{value}</strong>
            <div
              style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)', marginTop: '0.15rem' }}
            >
              {label}
            </div>
          </div>
        ))}
      </div>

      <BadgesRow badges={stats.badges} />
      <FavoritesSection />

      <div style={{ display: 'grid', gap: '0.85rem' }}>
        {campaigns.map((campaign) => (
          <BackedCampaignCard
            key={campaign.campaign_id}
            campaign={campaign}
            onRefundClaimed={load}
          />
        ))}
      </div>
    </div>
  );
}
