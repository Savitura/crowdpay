import React, { useState } from 'react';
import { api } from '../services/api';

export default function KycPrompt({ token, onUserUpdate, title = 'Verify your identity to create campaigns' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function startKyc() {
    setBusy(true);
    setError('');
    try {
      const result = await api.startKyc(token);
      if (result.user && onUserUpdate) onUserUpdate(result.user);
      if (result.redirect_url) {
        window.location.assign(result.redirect_url);
        return;
      }
      setError('Verification session started, but no redirect URL was returned.');
    } catch (err) {
      setError(err.message || 'Could not start identity verification.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="alert alert--warning" role="status">
      <strong>{title}</strong>
      <p style={{ marginTop: '0.35rem' }}>
        CrowdPay requires verified creator identity before launch so backers can trust who receives funds.
      </p>
      {error && (
        <p className="alert alert--error" style={{ marginTop: '0.75rem' }} role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn-primary"
        style={{ marginTop: '0.75rem', width: '100%' }}
        disabled={busy}
        onClick={startKyc}
      >
        {busy ? 'Starting verification...' : 'Verify your identity'}
      </button>
    </div>
  );
}
