import React from 'react';
import { Link } from 'react-router-dom';
import VerificationBadge from './VerificationBadge';
import CampaignStatusBadge from './CampaignStatusBadge';

function progressColor(pct, status) {
  if (status === 'funded' || pct >= 100) return '#10b981'; // green — goal reached
  if (status === 'closed' || status === 'withdrawn') return '#6b7280'; // grey — ended
  if (pct >= 75) return '#3b82f6'; // blue — nearly there
  return '#7c3aed'; // default purple
}

function daysLeft(deadline) {
  if (!deadline) return null;
  const diff = Math.ceil((new Date(deadline) - Date.now()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return 'Ended';
  if (diff === 0) return 'Last day';
  return `${diff}d left`;
}

export default function CampaignCard({ campaign }) {
  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
  const fillColor = progressColor(parseFloat(pct), campaign.status);
  const deadline = daysLeft(campaign.deadline);
  const deadlineColor = deadline === 'Ended' ? '#ef4444' : deadline === 'Last day' ? '#f59e0b' : '#f59e0b';

  return (
    <Link to={`/campaigns/${campaign.id}`} style={{ display: 'block' }} className="campaign-card-link">
      <div className="campaign-card" style={styles.card}>
        {campaign.cover_image_url ? (
          <div style={styles.coverImageWrapper}>
            <img alt={campaign.title} src={campaign.cover_image_url} style={styles.coverImage} />
          </div>
        ) : (
          <div style={styles.coverPlaceholder} aria-hidden="true">
            <span style={styles.coverPlaceholderText}>No campaign image</span>
          </div>
        )}
        <div style={styles.header}>
          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={styles.asset}>{campaign.asset_type}</span>
            <CampaignStatusBadge status={campaign.status} />
          </div>
          <VerificationBadge status={campaign.creator_kyc_status} compact />
        </div>
        {typeof campaign.updates_count === 'number' && (
          <div style={styles.updates}>{campaign.updates_count} updates</div>
        )}
        <h3 style={styles.title}>{campaign.title}</h3>
        <p style={styles.desc}>{campaign.description?.slice(0, 100)}{campaign.description?.length > 100 ? '…' : ''}</p>
        <div style={styles.bar}>
          <div style={{ ...styles.fill, background: fillColor, width: `${pct}%` }} />
        </div>
        {deadline && (
          <span style={{ ...styles.deadline, background: deadlineColor === '#ef4444' ? '#fee2e2' : '#fef3c7', color: deadlineColor, borderColor: deadlineColor }}>
            {deadline}
          </span>
        )}
        <div style={styles.meta}>
          <span><strong>{Number(campaign.raised_amount).toLocaleString()}</strong> {campaign.asset_type} raised</span>
          <span>{pct}% by <strong>{campaign.contributor_count || 0}</strong> backers</span>
        </div>
        <div style={styles.target}>
          Goal: {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}
        </div>
      </div>
    </Link>
  );
}

const styles = {
  card: { background: 'var(--color-bg)', border: '1px solid var(--color-border-light)', borderRadius: '10px', padding: '1.25rem', transition: 'box-shadow 0.15s' },
  header: { marginBottom: '0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  asset: { background: 'var(--color-accent-lightest)', color: 'var(--color-accent)', fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '99px' },
  updates: { fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-success-text)', marginBottom: '0.45rem' },
  title: { fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.4rem', color: 'var(--color-text-primary)' },
  desc: { fontSize: '0.875rem', color: 'var(--color-text-hint)', marginBottom: '1rem' },
  coverImageWrapper: { overflow: 'hidden', borderRadius: '12px 12px 0 0', marginBottom: '1rem', height: '160px' },
  coverImage: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  bar: { background: 'var(--color-surface)', borderRadius: '99px', height: '6px', marginBottom: '0.5rem', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: '99px', transition: 'width 0.3s' },
  deadline: { display: 'inline-block', fontSize: '0.75rem', fontWeight: 700, padding: '4px 8px', borderRadius: '99px', marginBottom: '0.5rem', border: '1px solid' },
  meta: { display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--color-text-secondary)' },
  target: { fontSize: '0.8rem', color: 'var(--color-text-muted)', marginTop: '0.3rem' },
  coverPlaceholder: {
    borderRadius: '12px 12px 0 0',
    marginBottom: '1rem',
    height: '160px',
    background: 'linear-gradient(135deg, #ede9fe 0%, #e0e7ff 100%)',
    border: '1px solid #ddd6fe',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverPlaceholderText: { color: '#6d28d9', fontWeight: 700, fontSize: '0.85rem' },
};
