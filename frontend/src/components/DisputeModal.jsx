import React, { useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

const REASONS = [
  { value: 'non_delivery', label: 'Non-delivery — creator has not delivered what was promised' },
  { value: 'misrepresentation', label: 'Misrepresentation — campaign details were false or misleading' },
  { value: 'abandoned', label: 'Abandoned — creator is unresponsive or has abandoned the project' },
  { value: 'other', label: 'Other' },
];

export default function DisputeModal({ campaign, onClose, onSubmitted }) {
  const { token } = useAuth();
  const [form, setForm] = useState({ reason: 'non_delivery', description: '', evidence_url: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.raiseDispute(campaign.id, {
        reason: form.reason,
        description: form.description.trim(),
        evidence_url: form.evidence_url.trim() || undefined,
      }, token);
      onSubmitted?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Could not submit dispute');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="dispute-title">
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 id="dispute-title" style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>
            Report a problem
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>✕</button>
        </div>
        <p style={{ color: '#555', fontSize: '0.9rem', marginBottom: '1.25rem' }}>
          Raising a dispute will freeze any pending withdrawals on <strong>{campaign.title}</strong> while the platform reviews your claim.
        </p>
        <form onSubmit={handleSubmit}>
          <label style={labelStyle} htmlFor="dispute-reason">Reason</label>
          <select
            id="dispute-reason"
            value={form.reason}
            onChange={(e) => setForm((s) => ({ ...s, reason: e.target.value }))}
            style={{ marginBottom: '1rem', width: '100%' }}
            required
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>

          <label style={labelStyle} htmlFor="dispute-description">Description</label>
          <textarea
            id="dispute-description"
            value={form.description}
            onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
            rows={4}
            placeholder="Describe the problem in detail…"
            required
            style={{ marginBottom: '1rem', width: '100%' }}
          />

          <label style={labelStyle} htmlFor="dispute-evidence">Evidence URL (optional)</label>
          <input
            id="dispute-evidence"
            type="url"
            value={form.evidence_url}
            onChange={(e) => setForm((s) => ({ ...s, evidence_url: e.target.value }))}
            placeholder="https://…"
            style={{ marginBottom: '1.25rem', width: '100%' }}
          />

          {error && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Submitting…' : 'Submit dispute'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modal = {
  background: '#fff', borderRadius: '12px', padding: '1.75rem',
  width: '100%', maxWidth: '480px', maxHeight: '90vh', overflowY: 'auto',
};
const closeBtn = {
  background: 'transparent', border: 'none', fontSize: '1.1rem',
  cursor: 'pointer', color: '#666', padding: '0.25rem',
};
const labelStyle = { display: 'block', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' };
