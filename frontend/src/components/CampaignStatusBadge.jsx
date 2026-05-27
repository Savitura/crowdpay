import React from 'react';

const LABELS = {
  funded: { text: 'Goal reached', bg: '#dcfce7', color: '#166534' },
  failed: { text: 'Campaign ended', bg: '#fee2e2', color: '#991b1b' },
  closed: { text: 'Campaign closed', bg: '#f3f4f6', color: '#374151' },
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
