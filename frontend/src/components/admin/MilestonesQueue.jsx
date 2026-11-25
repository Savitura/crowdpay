import { useEffect, useState } from 'react';
import { api } from '../../services/api';

export default function MilestonesQueue() {
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setLoading(true);
    api
      .getAdminMilestones({ status: 'pending_review' })
      .then(setMilestones)
      .catch(() => setMilestones([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function approve(milestone) {
    if (!window.confirm(`Approve and release funds for "${milestone.title}"?`)) return;
    setBusyId(milestone.id);
    try {
      await api.approveMilestone(milestone.id);
      load();
    } catch (err) {
      alert(err.message || 'Could not approve milestone');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(milestone) {
    const reason = rejectReason.trim();
    if (!reason) {
      alert('A rejection reason is required.');
      return;
    }
    setBusyId(milestone.id);
    try {
      await api.rejectMilestone(milestone.id, { reason });
      setRejectingId(null);
      setRejectReason('');
      load();
    } catch (err) {
      alert(err.message || 'Could not reject milestone');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading milestone queue…</p>;
  if (!milestones.length) {
    return (
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2.5rem' }}>
        No milestones awaiting evidence review.
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {milestones.map((m) => (
        <div
          key={m.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <strong>{m.title}</strong>
              <div
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-hint)',
                  marginTop: '0.2rem',
                }}
              >
                {m.campaign_title} · {m.creator_name || m.creator_email}
              </div>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'var(--color-warning-bg)',
                color: 'var(--color-warning-text)',
              }}
            >
              pending review
            </span>
          </div>

          {m.evidence_description && (
            <p style={{ margin: '0.65rem 0 0', fontSize: '0.9rem' }}>{m.evidence_description}</p>
          )}

          {m.evidence_url && (
            <p style={{ margin: '0.45rem 0 0', fontSize: '0.85rem' }}>
              Evidence:{' '}
              <a
                href={m.evidence_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-accent)' }}
              >
                View proof
              </a>
            </p>
          )}

          <div
            style={{ marginTop: '0.45rem', fontSize: '0.82rem', color: 'var(--color-text-hint)' }}
          >
            Release: {Number(m.release_percentage).toLocaleString()}% · Destination:{' '}
            <code>{m.destination_key?.slice(0, 8)}…</code>
            {m.evidence_submitted_at && (
              <span> · Submitted {new Date(m.evidence_submitted_at).toLocaleString()}</span>
            )}
          </div>

          {rejectingId === m.id ? (
            <div
              style={{
                marginTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.45rem',
              }}
            >
              <label htmlFor={`milestone-reject-${m.id}`} className="sr-only">
                Rejection reason
              </label>
              <textarea
                id={`milestone-reject-${m.id}`}
                value={rejectReason}
                style={{
                  fontSize: '0.85rem',
                  resize: 'vertical',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  fontFamily: 'inherit',
                }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '0.45rem' }}>
                <button
                  type="button"
                  disabled={busyId === m.id}
                  onClick={() => reject(m)}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.35rem 0.8rem',
                    borderRadius: '6px',
                    border: '1px solid var(--color-border-light)',
                    background: 'var(--color-error-bg)',
                    color: 'var(--color-error-text)',
                    cursor: 'pointer',
                  }}
                >
                  Confirm reject
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRejectingId(null);
                    setRejectReason('');
                  }}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.35rem 0.8rem',
                    borderRadius: '6px',
                    border: '1px solid var(--color-border-light)',
                    background: 'var(--color-bg-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
              <button
                type="button"
                disabled={busyId === m.id}
                onClick={() => approve(m)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.35rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-success-border)',
                  background: 'var(--color-success-bg)',
                  color: 'var(--color-success-text)',
                  cursor: 'pointer',
                }}
              >
                {busyId === m.id ? 'Approving…' : 'Approve & release'}
              </button>
              <button
                type="button"
                disabled={busyId === m.id}
                onClick={() => setRejectingId(m.id)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.35rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary)',
                  cursor: 'pointer',
                }}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
