import React, { useState } from 'react';
import RelativeTime from '../../RelativeTime';
import ContributionListSkeleton from '../../skeletons/ContributionListSkeleton';
import { stellarExpertTxUrl } from '../../../config/stellar';

export function ContributionRow({ c }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (c.sender_public_key) {
      navigator.clipboard.writeText(c.sender_public_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div style={styles.row}>
      <div
        style={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <div style={styles.avatar}>{(c.display_name || 'A')[0].toUpperCase()}</div>
        <div style={{ minWidth: 0 }}>
          <div style={styles.sender}>{c.display_name || 'Anonymous'}</div>
          <div style={styles.convHint}>
            {c.sender_public_key ? (
              <button
                type="button"
                onClick={handleCopy}
                title={copied ? 'Copied!' : 'Copy full public key'}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  fontFamily: 'monospace',
                  fontSize: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {c.sender_public_key.slice(0, 4)}...{c.sender_public_key.slice(-4)}
              </button>
            ) : null}
            {' - '}
            <RelativeTime date={c.created_at} />
          </div>
          {c.refund_status && (
            <div style={styles.refundTag}>
              {c.refund_status === 'pending' && 'Refund pending'}
              {c.refund_status === 'submitted' && 'Refunded'}
              {c.refund_status === 'indexed' && 'Refunded'}
              {c.refund_status === 'failed' && 'Refund failed'}
              {c.refund_status === 'denied' && 'Refund denied'}
            </div>
          )}
          {c.tx_hash && (
            <a
              href={stellarExpertTxUrl(c.tx_hash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '0.75rem', color: 'var(--color-accent)', fontWeight: 600 }}
            >
              View on chain
            </a>
          )}
        </div>
      </div>
      {c.amount !== null && (
        <span style={styles.amount}>
          {Number(c.amount).toLocaleString()} {c.asset}
        </span>
      )}
    </div>
  );
}

export default function CampaignContributionsTab({
  contributions = null,
  totalContributions = 0,
  isLive = false,
  showAll = false,
  setShowAll,
}) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={styles.sectionTitle}>
        Backer Wall {contributions !== null ? `(${totalContributions})` : ''}
        {isLive && (
          <span style={styles.liveIndicator} title="Live updates active">
            <span style={styles.liveDot} />
            Live
          </span>
        )}
      </h2>

      {contributions === null ? (
        <ContributionListSkeleton />
      ) : contributions.length === 0 ? (
        <div style={styles.emptyBackers}>
          <p>Be the first to back this!</p>
          <p
            style={{
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Every contribution counts towards making this goal a reality.
          </p>
        </div>
      ) : (
        <>
          <div style={styles.list} className="contributions-list">
            {contributions.map((c) => (
              <ContributionRow key={c.id} c={c} />
            ))}
          </div>
          {totalContributions > 10 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                marginTop: '1rem',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAll?.((prev) => !prev)}
                style={{
                  padding: '0.5rem 1.5rem',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                {showAll ? 'Show less' : `Show all (${totalContributions})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-lighter)',
    borderRadius: '6px',
    padding: '0.6rem 0.85rem',
  },
  sender: { fontSize: '0.85rem', color: 'var(--color-text-secondary)', fontFamily: 'monospace' },
  amount: { fontSize: '0.85rem', fontWeight: 600, flexShrink: 0 },
  convHint: { fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: '0.15rem' },
  refundTag: {
    marginTop: '0.45rem',
    fontSize: '0.75rem',
    color: 'var(--color-accent)',
    fontWeight: 700,
  },
  liveIndicator: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: '0.5rem',
    fontSize: '0.72rem',
    fontWeight: 600,
    color: 'var(--color-success-text)',
    verticalAlign: 'middle',
  },
  liveDot: {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--color-success-text)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  emptyBackers: {
    padding: '2.5rem 1rem',
    textAlign: 'center',
    background: 'var(--color-accent-lightest)',
    border: '2px dashed var(--color-accent-lighter)',
    borderRadius: '12px',
    color: 'var(--color-accent)',
    fontWeight: 700,
  },
  avatar: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.9rem',
    fontWeight: 800,
    flexShrink: 0,
  },
};
