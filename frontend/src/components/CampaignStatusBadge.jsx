import { useTranslation } from 'react-i18next';

const LABELS = {
  funded: {
    key: 'campaignStatus.goalReached',
    bg: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
  },
  failed: {
    key: 'campaignStatus.campaignEnded',
    bg: 'var(--color-error-bg)',
    color: 'var(--color-error-text)',
  },
  closed: {
    key: 'campaignStatus.campaignClosed',
    bg: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
  },
  refunded: {
    key: 'campaignStatus.refunded',
    bg: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
  },
  draft: {
    key: 'campaignStatus.draft',
    bg: 'var(--color-warning-bg, #fffbeb)',
    color: 'var(--color-warning-text, #92400e)',
  },
  disputed: {
    key: 'campaignStatus.disputed',
    bg: 'var(--color-error-bg)',
    color: 'var(--color-error-text)',
  },
  in_progress: {
    key: 'campaignStatus.inProgress',
    bg: 'var(--color-info-bg, #eff6ff)',
    color: 'var(--color-info-text, #1d4ed8)',
  },
  completed: {
    key: 'campaignStatus.completed',
    bg: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
  },
  withdrawn: {
    key: 'campaignStatus.withdrawn',
    bg: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
  },
  suspended: {
    key: 'campaignStatus.suspended',
    bg: 'var(--color-error-bg)',
    color: 'var(--color-error-text)',
  },
};

export default function CampaignStatusBadge({ status }) {
  const { t } = useTranslation();
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
      {t(style.key)}
    </span>
  );
}
