import React from 'react';

const LABELS = {
  funded: { text: 'Goal reached', bg: 'var(--color-success-bg)', color: 'var(--color-success-text)' },
  failed: { text: 'Campaign ended', bg: 'var(--color-error-bg)', color: 'var(--color-error-text)' },
  closed: { text: 'Campaign closed', bg: 'var(--color-surface)', color: 'var(--color-text-secondary)' },
};

export default function CampaignStatusBadge({ status }) {
  if (!status || status === 'active') return null;
  const style = LABELS[status];
  if (!style) return null;

  return (
    <span
      style={{
        background: style.bg,
        color: style.color,
        fontSize: '0.72rem',
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: '99px',
        whiteSpace: 'nowrap',
      }}
    >
      {style.text}
    </span>
  );
}
