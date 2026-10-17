import { useState } from 'react';
import { api } from '../services/api';

export default function EvidenceForm({ disputeId, onSubmitted, onClose }) {
  const [text, setText] = useState('');
  const [urls, setUrls] = useState(['']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function updateUrl(index, value) {
    setUrls((prev) => prev.map((u, i) => (i === index ? value : u)));
  }

  function addUrlField() {
    setUrls((prev) => [...prev, '']);
  }

  function removeUrlField(index) {
    setUrls((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!text.trim()) {
      setError('Please describe your evidence.');
      return;
    }
    setBusy(true);
    try {
      await api.submitDisputeEvidence(disputeId, {
        text: text.trim(),
        attachmentUrls: urls.map((u) => u.trim()).filter(Boolean),
      });
      setText('');
      setUrls(['']);
      onSubmitted?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not submit evidence');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
      <div>
        <label style={labelStyle} htmlFor="evidence-text">
          Describe your evidence
        </label>
        <textarea
          id="evidence-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Explain what happened and how this supports your side..."
          style={{ width: '100%' }}
          required
        />
      </div>

      <div>
        <label style={labelStyle}>Attachment links (optional)</label>
        {urls.map((url, i) => (
          <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem' }}>
            <input
              type="url"
              value={url}
              onChange={(e) => updateUrl(i, e.target.value)}
              placeholder="https://..."
              style={{ flex: 1 }}
            />
            {urls.length > 1 && (
              <button type="button" className="btn-secondary" onClick={() => removeUrlField(i)}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary"
          onClick={addUrlField}
          style={{ fontSize: '0.85rem' }}
        >
          + Add URL
        </button>
      </div>

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
        {onClose && (
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Submitting...' : 'Submit evidence'}
        </button>
      </div>
    </form>
  );
}

const labelStyle = {
  display: 'block',
  fontWeight: 600,
  fontSize: '0.9rem',
  marginBottom: '0.35rem',
};
