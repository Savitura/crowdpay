import React, { useEffect, useState } from 'react';
import { api } from '../services/api';

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [revealedKey, setRevealedKey] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);

  async function loadKeys() {
    setError('');
    try {
      const rows = await api.listApiKeys();
      setKeys(rows);
    } catch (err) {
      setError(err.message || 'Could not load API keys');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadKeys();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    setRevealedKey('');
    try {
      const res = await api.createApiKey({ name: name.trim() });
      setRevealedKey(res.api_key);
      setName('');
      await loadKeys();
    } catch (err) {
      setError(err.message || 'Could not create API key');
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(id) {
    if (!window.confirm('Revoke this API key? Integrations using it will stop working immediately.')) return;
    setError('');
    try {
      await api.deleteApiKey(id);
      await loadKeys();
    } catch (err) {
      setError(err.message || 'Could not revoke API key');
    }
  }

  function copyKey() {
    if (!revealedKey) return;
    navigator.clipboard.writeText(revealedKey);
  }

  return (
    <section role="tabpanel" aria-labelledby="tab-api-keys">
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1rem', fontSize: '0.9rem' }}>
        Generate long-lived API keys for server-side integrations. Use{' '}
        <code>Authorization: Bearer cpk_…</code> on authenticated endpoints.
      </p>

      {error && <p style={{ color: 'var(--color-status-error)', marginBottom: '1rem' }}>{error}</p>}
      {loading && <p style={{ color: 'var(--color-text-hint)' }}>Loading API keys…</p>}

      <button
        type="button"
        className="btn-primary"
        style={{ marginBottom: '1rem' }}
        onClick={() => {
          setShowModal(true);
          setRevealedKey('');
          setName('');
        }}
      >
        Create key
      </button>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
              <th style={{ padding: '0.4rem' }}>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.filter((k) => !k.revoked_at).map((k) => (
              <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border-lighter)' }}>
                <td style={{ padding: '0.45rem' }}>{k.name || k.label}</td>
                <td><code>{k.key_prefix}</code></td>
                <td style={{ color: 'var(--color-text-hint)' }}>
                  {k.created_at ? new Date(k.created_at).toLocaleDateString() : '—'}
                </td>
                <td style={{ color: 'var(--color-text-hint)' }}>
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                    onClick={() => revokeKey(k.id)}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            className="campaign-card"
            style={{ width: 'min(480px, 92vw)', padding: '1.5rem' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0, fontSize: '1.2rem' }}>Create API key</h2>

            {revealedKey ? (
              <>
                <div
                  style={{
                    background: 'var(--color-warning-bg)',
                    border: '1px solid var(--color-warning-border)',
                    padding: '0.85rem',
                    borderRadius: 8,
                    marginBottom: '1rem',
                  }}
                >
                  <strong>Store this key — it will not be shown again.</strong>
                  <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>
                    {revealedKey}
                  </pre>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn-secondary" onClick={copyKey}>Copy key</button>
                  <button type="button" className="btn-primary" onClick={() => setShowModal(false)}>Done</button>
                </div>
              </>
            ) : (
              <form onSubmit={handleCreate}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                  Key name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My bot integration"
                  required
                  style={{ width: '100%', marginBottom: '1rem' }}
                />
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary" disabled={creating}>
                    {creating ? 'Creating…' : 'Generate key'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
