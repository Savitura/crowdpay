import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import VerificationBadge from './VerificationBadge';
import CampaignStatusBadge from './CampaignStatusBadge';

function progressColor(pct, status) {
  if (status === 'funded' || pct >= 100) return '#10b981';
  if (status === 'closed' || status === 'withdrawn' || status === 'refunded' || status === 'failed')
    return '#6b7280';
  if (pct >= 75) return '#4f83f1';
  return '#2563eb';
}

function daysLeft(deadline) {
  if (!deadline) return null;
  const diff = Math.ceil((new Date(deadline) - Date.now()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return { kind: 'ended' };
  if (diff === 0) return { kind: 'lastDay' };
  return { kind: 'count', value: diff };
}

const CATEGORY_STYLES = {
  education: { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  community: { bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0' },
  technology: { bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe' },
  arts: { bg: '#fdf2f8', color: '#be185d', border: '#fbcfe8' },
  environment: { bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
  health: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
  business: { bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
  open_source: { bg: '#f0fdfa', color: '#0d9488', border: '#99f6e4' },
  startup: { bg: '#fef3c7', color: '#d97706', border: '#fde68a' },
  emergency: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
  other: { bg: '#f9fafb', color: '#4b5563', border: '#e5e7eb' },
};

const CATEGORY_LABELS = {
  technology: 'Technology',
  community: 'Community',
  arts: 'Arts & Culture',
  education: 'Education',
  environment: 'Environment',
  health: 'Health',
  business: 'Business',
  open_source: 'Open Source',
  startup: 'Startup',
  emergency: 'Emergency',
  other: 'Other',
};

export default function CampaignCard({ campaign, featured }) {
  const { t } = useTranslation();
  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
  const fillColor = progressColor(parseFloat(pct), campaign.status);
  const deadline = daysLeft(campaign.deadline);
  const category = campaign.category || 'other';
  const catStyle = CATEGORY_STYLES[category] || CATEGORY_STYLES.other;

  return (
    <Link
      to={`/campaigns/${campaign.id}`}
      style={{ display: 'block' }}
      className="campaign-card-link"
    >
      <div className="campaign-card" style={styles.card}>
        {campaign.cover_image_url ? (
          <div style={styles.imageWrapper}>
            <img alt={campaign.title} src={campaign.cover_image_url} style={styles.image} />
            {campaign.category && (
              <span
                style={{
                  ...styles.categoryBadge,
                  background: catStyle.bg,
                  color: catStyle.color,
                  borderColor: catStyle.border,
                }}
              >
                {CATEGORY_LABELS[campaign.category] || campaign.category}
              </span>
            )}
          </div>
        ) : (
          <div
            style={{
              ...styles.imageWrapper,
              ...styles.placeholder,
            }}
            aria-hidden="true"
          >
            <span style={styles.placeholderText}>{t('campaignCard.noImage')}</span>
            {campaign.category && (
              <span
                style={{
                  ...styles.categoryBadge,
                  ...styles.categoryBadgeOnImage,
                  background: catStyle.bg,
                  color: catStyle.color,
                  borderColor: catStyle.border,
                }}
              >
                {CATEGORY_LABELS[campaign.category] || campaign.category}
              </span>
            )}
          </div>
        )}

        <div style={styles.content}>
          <div style={styles.header}>
            <div style={styles.headerLeft}>
              {campaign.asset_type && (
                <span style={styles.assetBadge}>{campaign.asset_type}</span>
              )}
              <CampaignStatusBadge status={campaign.status} />
            </div>
            <VerificationBadge status={campaign.creator_kyc_status} compact />
          </div>

          <h3 style={styles.title}>{campaign.title}</h3>

          {campaign.creator_name && (
            <p style={styles.creator}>{t('campaignCard.by', { name: campaign.creator_name })}</p>
          )}

          <div style={styles.progressSection}>
            <div style={styles.amountRow}>
              <span style={styles.raisedAmount}>
                <strong>${Number(campaign.raised_amount).toLocaleString()}</strong> raised
              </span>
              <span style={styles.targetAmount}>
                of ${Number(campaign.target_amount).toLocaleString()}
              </span>
            </div>
            <div className="progress-bar" style={styles.progressBar}>
              <div
                className="progress-bar-fill"
                style={{ ...styles.progressFill, width: `${pct}%`, background: fillColor }}
              />
            </div>
          </div>

          <div style={styles.footer}>
            <span style={styles.footerStat}>
              {campaign.contributor_count || 0} donors
            </span>
            {deadline && (
              <span style={styles.footerStat}>
                {deadline.kind === 'ended'
                  ? t('campaignCard.ended')
                  : deadline.kind === 'lastDay'
                    ? t('campaignCard.lastDay')
                    : t('campaignCard.daysLeft', { count: deadline.value })}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

const styles = {
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '14px',
    overflow: 'hidden',
    transition: 'box-shadow 0.2s ease, transform 0.2s ease',
  },
  imageWrapper: {
    position: 'relative',
    height: '180px',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  placeholder: {
    background: 'linear-gradient(135deg, #e0e7ff 0%, #ccfbf1 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: 'var(--color-accent)',
    fontWeight: 600,
    fontSize: '0.85rem',
  },
  categoryBadge: {
    position: 'absolute',
    top: '12px',
    left: '12px',
    fontSize: '0.72rem',
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: '99px',
    border: '1px solid',
    textTransform: 'capitalize',
  },
  categoryBadgeOnImage: {
    top: '12px',
    left: '12px',
  },
  content: {
    padding: '1rem 1.25rem 1.25rem',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.65rem',
  },
  headerLeft: {
    display: 'flex',
    gap: '0.35rem',
    alignItems: 'center',
  },
  assetBadge: {
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    fontSize: '0.7rem',
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: '99px',
  },
  title: {
    fontSize: '1rem',
    fontWeight: 700,
    marginBottom: '0.35rem',
    color: 'var(--color-text-primary)',
    lineHeight: 1.3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  creator: {
    fontSize: '0.8rem',
    color: 'var(--color-text-hint)',
    marginBottom: '0.75rem',
  },
  progressSection: {
    marginBottom: '0.75rem',
  },
  amountRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: '0.5rem',
  },
  raisedAmount: {
    fontSize: '0.9rem',
    color: 'var(--color-text-primary)',
  },
  targetAmount: {
    fontSize: '0.8rem',
    color: 'var(--color-text-hint)',
  },
  progressBar: {
    height: '6px',
  },
  progressFill: {
    height: '100%',
    borderRadius: '99px',
    transition: 'width 0.3s ease',
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    paddingTop: '0.65rem',
    borderTop: '1px solid var(--color-border-light)',
  },
  footerStat: {
    fontSize: '0.8rem',
    color: 'var(--color-text-secondary)',
    fontWeight: 500,
  },
};
