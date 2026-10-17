import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';

const STATUS_OPTIONS = ['all', 'submitted', 'approved', 'pending', 'failed', 'denied'];

function formatDate(value) {
  if (!value) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function shortHash(hash) {
  if (!hash) return null;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

export default function WithdrawalHistoryTimeline({ campaignId, token }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('desc');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');
    api
      .getContributorWithdrawalHistory(campaignId, { status, sort })
      .then((data) => setRows(Array.isArray(data?.data) ? data.data : []))
      .catch((err) => setError(err.message || 'Could not load withdrawal history.'))
      .finally(() => setLoading(false));
  }, [campaignId, status, sort, token]);

  const totalReleased = useMemo(
    () =>
      rows
        .filter((row) => row.status === 'submitted')
        .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [rows]
  );

  if (!token) return null;

  return (
    <section style={styles.section} aria-label="Contributor withdrawal history">
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>Withdrawal history</h2>
          <p style={styles.intro}>
            Track how funds have been released from this campaign, including recipients and on-chain
            transaction hashes.
          </p>
        </div>
        <div style={styles.summary}>
          <span style={styles.summaryLabel}>Released</span>
          <strong>{totalReleased.toLocaleString()}</strong>
        </div>
      </div>

      <div style={styles.controls}>
        <label style={styles.controlLabel}>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={styles.select}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? 'All statuses' : option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.controlLabel}>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={styles.select}>
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
      </div>

      {error && <p className="alert alert--error">{error}</p>}
      {loading && rows.length === 0 ? (
        <p style={styles.muted}>Loading withdrawal history...</p>
      ) : rows.length === 0 ? (
        <p style={styles.muted}>No withdrawals have been recorded for this campaign yet.</p>
      ) : (
        <ol style={styles.timeline}>
          {rows.map((row) => (
            <li key={row.id} style={styles.item}>
              <div style={styles.dot} />
              <div style={styles.card}>
                <div style={styles.itemTop}>
                  <strong>
                    {row.amount} {row.asset_type || ''}
                  </strong>
                  <span style={styles.status}>{row.status}</span>
                </div>
                <div style={styles.meta}>{formatDate(row.created_at)}</div>
                {row.milestone_title && (
                  <div style={styles.meta}>Milestone: {row.milestone_title}</div>
                )}
                <div style={styles.meta}>
                  Recipient: <code>{row.destination_key || 'Pending'}</code>
                </div>
                {row.tx_hash && (
                  <a
                    href={stellarExpertTxUrl(row.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.link}
                  >
                    {shortHash(row.tx_hash)} on Stellar Expert
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const styles = {
  section: {
    marginBottom: '2rem',
    padding: '1.25rem',
    border: '1px solid var(--color-border-light)',
    borderRadius: '8px',
    background: 'var(--color-surface)',
  },
  header: { display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '1.25rem' },
  intro: { margin: '0.35rem 0 0', color: 'var(--color-text-hint)', maxWidth: '46rem' },
  summary: { textAlign: 'right', minWidth: '8rem' },
  summaryLabel: { display: 'block', color: 'var(--color-text-hint)', fontSize: '0.8rem' },
  controls: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' },
  controlLabel: {
    display: 'grid',
    gap: '0.25rem',
    fontSize: '0.85rem',
    color: 'var(--color-text-secondary)',
  },
  select: {
    minWidth: '10rem',
    padding: '0.45rem 0.6rem',
    borderRadius: '6px',
    border: '1px solid var(--color-border-light)',
  },
  muted: { color: 'var(--color-text-muted)' },
  timeline: { listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'grid', gap: '0.85rem' },
  item: { display: 'grid', gridTemplateColumns: '14px 1fr', gap: '0.75rem', alignItems: 'start' },
  dot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: 'var(--color-accent)',
    marginTop: '0.45rem',
  },
  card: { borderLeft: '2px solid var(--color-border-light)', paddingLeft: '0.85rem' },
  itemTop: { display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' },
  status: { textTransform: 'capitalize', color: 'var(--color-text-hint)', fontSize: '0.85rem' },
  meta: { marginTop: '0.25rem', color: 'var(--color-text-secondary)', fontSize: '0.9rem' },
  link: { display: 'inline-block', marginTop: '0.4rem', color: 'var(--color-accent)' },
};
