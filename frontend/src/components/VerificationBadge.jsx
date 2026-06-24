import React from 'react';

export default function VerificationBadge({ status, compact = false }) {
  if (status === 'verified') {
    return <span style={compact ? styles.verifiedCompact : styles.verified}>✓ Verified</span>;
  }
  if (status === 'pending') {
    return <span style={compact ? styles.pendingCompact : styles.pending}>Pending verification</span>;
  }
  if (status === 'rejected') {
    return <span style={compact ? styles.rejectedCompact : styles.rejected}>Verification rejected</span>;
  }

  return <span style={compact ? styles.warningCompact : styles.warning}>Not verified</span>;
}

const base = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '99px',
  fontWeight: 700,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const styles = {
  verified: {
    ...base,
    background: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
    border: '1px solid var(--color-success-border)',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  verifiedCompact: {
    ...base,
    background: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
    border: '1px solid var(--color-success-border)',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
  warning: {
    ...base,
    background: 'var(--color-warning-bg)',
    color: 'var(--color-warning-text)',
    border: '1px solid var(--color-warning-border)',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  warningCompact: {
    ...base,
    background: 'var(--color-warning-bg)',
    color: 'var(--color-warning-text)',
    border: '1px solid var(--color-warning-border)',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
  pending: {
    ...base,
    background: 'var(--color-accent-soft)',
    color: 'var(--color-accent)',
    border: '1px solid var(--color-border-light)',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  pendingCompact: {
    ...base,
    background: 'var(--color-accent-soft)',
    color: 'var(--color-accent)',
    border: '1px solid var(--color-border-light)',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
  rejected: {
    ...base,
    background: 'var(--color-danger-bg, #fef2f2)',
    color: 'var(--color-danger, #b91c1c)',
    border: '1px solid var(--color-danger-border, #fecaca)',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  rejectedCompact: {
    ...base,
    background: 'var(--color-danger-bg, #fef2f2)',
    color: 'var(--color-danger, #b91c1c)',
    border: '1px solid var(--color-danger-border, #fecaca)',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
};
