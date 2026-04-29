import React from 'react';

export default function VerificationBadge({ status, compact = false }) {
  if (status === 'verified') {
    return <span style={compact ? styles.verifiedCompact : styles.verified}>✓ Verified Creator</span>;
  }

  return <span style={compact ? styles.warningCompact : styles.warning}>Unverified creator</span>;
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
    background: '#dcfce7',
    color: '#166534',
    border: '1px solid #86efac',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  verifiedCompact: {
    ...base,
    background: '#dcfce7',
    color: '#166534',
    border: '1px solid #86efac',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
  warning: {
    ...base,
    background: '#fffbeb',
    color: '#92400e',
    border: '1px solid #fcd34d',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  warningCompact: {
    ...base,
    background: '#fffbeb',
    color: '#92400e',
    border: '1px solid #fcd34d',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
};
