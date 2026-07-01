import { useState } from 'react';
import RelativeTime from './RelativeTime';

const OUTCOMES = [
  { value: '', label: '— Select an outcome —' },
  { value: 'resolved_for_creator', label: 'Resolved for creator (funds released)' },
  { value: 'resolved_for_contributor', label: 'Resolved for contributor (refund)' },
  { value: 'dismissed', label: 'Dismissed (no action)' },
];

const MIN_NOTE_LENGTH = 20;

/**
 * DisputeResolveModal
 *
 * Props:
 *   dispute  — dispute object (from admin detail response)
 *   thread   — array of message/event objects for the dispute
 *   onClose  — () => void
 *   onResolve — ({ status, resolution_note }) => Promise<void>
 */
export default function DisputeResolveModal({ dispute, thread = [], onClose, onResolve }) {
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const noteLength = note.trim().length;
  const noteShort = noteLength > 0 && noteLength < MIN_NOTE_LENGTH;

  // Map UI outcome values → backend status values
  const STATUS_MAP = {
    resolved_for_creator: 'resolved_creator',
    resolved_for_contributor: 'resolved_contributor',
    dismissed: 'closed',
  };

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!outcome) {
      setError('Please select a resolution outcome.');
      return;
    }
    if (noteLength < MIN_NOTE_LENGTH) {
      setError(`Resolution note must be at least ${MIN_NOTE_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      await onResolve({ status: STATUS_MAP[outcome], resolution_note: note.trim() });
    } catch (err) {
      setError(err.message || 'Could not resolve dispute. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-labelledby="dr-modal-title">
      <div style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 id="dr-modal-title" style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700 }}>
            Resolve Dispute #{dispute.id?.slice(0, 8)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={closeBtnStyle}
            disabled={busy}
          >
            ×
          </button>
        </div>

        {/* Dispute context preview */}
        <div style={contextBoxStyle}>
          <div style={contextRowStyle}>
            <span style={contextLabelStyle}>Campaign</span>
            <span>{dispute.campaign_title}</span>
          </div>
          <div style={contextRowStyle}>
            <span style={contextLabelStyle}>Reporter</span>
            <span>
              {dispute.reporter_name}
              {dispute.reporter_email ? ` (${dispute.reporter_email})` : ''}
            </span>
          </div>
          <div style={contextRowStyle}>
            <span style={contextLabelStyle}>Creator</span>
            <span>
              {dispute.creator_name}
              {dispute.creator_email ? ` (${dispute.creator_email})` : ''}
            </span>
          </div>
          <div style={contextRowStyle}>
            <span style={contextLabelStyle}>Reason</span>
            <span style={{ textTransform: 'capitalize' }}>{dispute.reason?.replace(/_/g, ' ')}</span>
          </div>
          {dispute.description && (
            <div style={{ ...contextRowStyle, alignItems: 'flex-start' }}>
              <span style={contextLabelStyle}>Description</span>
              <span style={{ flex: 1 }}>{dispute.description}</span>
            </div>
          )}
          {dispute.evidence_url && (
            <div style={contextRowStyle}>
              <span style={contextLabelStyle}>Evidence</span>
              <a
                href={dispute.evidence_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-accent)', wordBreak: 'break-all' }}
              >
                {dispute.evidence_url}
              </a>
            </div>
          )}
          {thread.length > 0 && (
            <div style={{ ...contextRowStyle, alignItems: 'flex-start' }}>
              <span style={contextLabelStyle}>Last activity</span>
              <span style={{ color: 'var(--color-text-hint)', fontSize: '0.82rem' }}>
                {thread[thread.length - 1]?.action} —{' '}
                <RelativeTime date={thread[thread.length - 1]?.created_at} />
              </span>
            </div>
          )}
        </div>

        {/* Resolution form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle} htmlFor="dr-outcome">
              Resolution outcome <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <select
              id="dr-outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              style={selectStyle}
              required
              disabled={busy}
            >
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value} disabled={o.value === ''}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle} htmlFor="dr-note">
              Resolution note <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <textarea
              id="dr-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              placeholder={`Explain the resolution decision (min ${MIN_NOTE_LENGTH} characters)…`}
              style={{
                ...textareaStyle,
                borderColor: noteShort ? 'var(--color-danger)' : 'var(--color-border-light)',
              }}
              required
              disabled={busy}
            />
            <div
              style={{
                fontSize: '0.78rem',
                marginTop: '0.25rem',
                color: noteShort ? 'var(--color-danger)' : 'var(--color-text-hint)',
                textAlign: 'right',
              }}
            >
              {noteLength} / {MIN_NOTE_LENGTH} min characters
            </div>
          </div>

          {error && (
            <p
              className="alert alert--error"
              role="alert"
              style={{ marginBottom: '1rem', fontSize: '0.875rem' }}
            >
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || !outcome || noteLength < MIN_NOTE_LENGTH}
            >
              {busy ? 'Resolving…' : 'Confirm resolution'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────── */

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1100,
  padding: '1rem',
};

const modalStyle = {
  background: 'var(--color-bg)',
  borderRadius: '12px',
  padding: '1.75rem',
  width: '100%',
  maxWidth: '520px',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '1.25rem',
};

const closeBtnStyle = {
  background: 'transparent',
  border: 'none',
  fontSize: '1.5rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'var(--color-text-hint)',
  padding: '0 0.25rem',
};

const contextBoxStyle = {
  background: 'var(--color-bg-secondary, #f9f9f9)',
  border: '1px solid var(--color-border-light)',
  borderRadius: '8px',
  padding: '0.9rem 1rem',
  marginBottom: '1.25rem',
  display: 'grid',
  gap: '0.45rem',
  fontSize: '0.875rem',
};

const contextRowStyle = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
};

const contextLabelStyle = {
  fontWeight: 600,
  minWidth: '90px',
  color: 'var(--color-text-hint)',
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const labelStyle = {
  display: 'block',
  fontWeight: 600,
  fontSize: '0.875rem',
  marginBottom: '0.4rem',
};

const selectStyle = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  borderRadius: '6px',
  border: '1px solid var(--color-border-light)',
  fontSize: '0.9rem',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};

const textareaStyle = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  borderRadius: '6px',
  border: '1px solid var(--color-border-light)',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  resize: 'vertical',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  boxSizing: 'border-box',
};
