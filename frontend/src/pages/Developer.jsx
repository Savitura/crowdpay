import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

const EVENT_OPTIONS = [
  'campaign.funded',
  'contribution.received',
  'milestone.approved',
  'withdrawal.completed',
];

const SCOPE_OPTIONS = ['read', 'write', 'withdrawals', 'developer', 'full'];

const V1_API_BASE = `${(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')}/api/v1`;

const V1_ENDPOINTS = [
  {
    id: 'list-campaigns',
    label: 'GET /campaigns — list public campaigns',
    method: 'GET',
    path: '/campaigns',
    auth: false,
    queryFields: ['search', 'status', 'asset', 'sort', 'limit', 'offset'],
  },
  {
    id: 'get-campaign',
    label: 'GET /campaigns/:id — campaign detail',
    method: 'GET',
    path: '/campaigns/:id',
    auth: false,
    pathFields: ['id'],
  },
  {
    id: 'list-contributions',
    label: 'GET /campaigns/:id/contributions — list contributions',
    method: 'GET',
    path: '/campaigns/:id/contributions',
    auth: true,
    pathFields: ['id'],
    queryFields: ['limit', 'offset'],
  },
  {
    id: 'create-contribution',
    label: 'POST /campaigns/:id/contributions — record from tx hash',
    method: 'POST',
    path: '/campaigns/:id/contributions',
    auth: true,
    pathFields: ['id'],
    bodyTemplate: { tx_hash: '' },
  },
  {
    id: 'users-me',
    label: 'GET /users/me — authenticated profile',
    method: 'GET',
    path: '/users/me',
    auth: true,
  },
];

export default function Developer() {
  const { user } = useAuth();
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [error, setError] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('Integration');
  const [newKeyScopes, setNewKeyScopes] = useState(['read', 'write', 'withdrawals']);
  const [revealedKey, setRevealedKey] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState(['contribution.received']);
  const [revealedSecret, setRevealedSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [explorerEndpoint, setExplorerEndpoint] = useState(V1_ENDPOINTS[0].id);
  const [explorerApiKey, setExplorerApiKey] = useState('');
  const [explorerPathParams, setExplorerPathParams] = useState({ id: '' });
  const [explorerQuery, setExplorerQuery] = useState({});
  const [explorerBody, setExplorerBody] = useState('{\n  "tx_hash": ""\n}');
  const [explorerResponse, setExplorerResponse] = useState('');
  const [explorerBusy, setExplorerBusy] = useState(false);
  const [explorerError, setExplorerError] = useState('');

  async function refresh() {
    setError('');
    try {
      const [k, h, d] = await Promise.all([
        api.listApiKeys(),
        api.listWebhooks(),
        api.listWebhookDeliveries({ limit: 80 }),
      ]);
      setKeys(k);
      setHooks(h);
      setDeliveries(d);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (!user) {
    return (
      <main className="container" style={{ paddingTop: '4rem', maxWidth: '720px' }}>
        <p><Link to="/login">Log in</Link> to manage API keys and webhooks.</p>
      </main>
    );
  }

  async function createKey(e) {
    e.preventDefault();
    setRevealedKey('');
    setError('');
    try {
      const res = await api.createApiKey({ label: newKeyLabel, scopes: newKeyScopes });
      setRevealedKey(res.api_key);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeKey(id) {
    if (!confirm('Revoke this API key?')) return;
    setError('');
    try {
      await api.deleteApiKey(id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createHook(e) {
    e.preventDefault();
    setRevealedSecret('');
    setError('');
    try {
      const res = await api.createWebhook({ url: hookUrl, events: hookEvents });
      setRevealedSecret(res.secret);
      setHookUrl('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeHook(id) {
    if (!confirm('Remove this webhook endpoint?')) return;
    setError('');
    try {
      await api.deleteWebhook(id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleEvent(ev) {
    setHookEvents((cur) =>
      cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]
    );
  }

  function toggleScope(sc) {
    setNewKeyScopes((cur) =>
      cur.includes(sc) ? cur.filter((x) => x !== sc) : [...cur, sc]
    );
  }

  const selectedEndpoint =
    V1_ENDPOINTS.find((e) => e.id === explorerEndpoint) || V1_ENDPOINTS[0];

  function buildExplorerUrl() {
    let path = selectedEndpoint.path;
    (selectedEndpoint.pathFields || []).forEach((field) => {
      path = path.replace(`:${field}`, encodeURIComponent(explorerPathParams[field] || ''));
    });
    const params = new URLSearchParams();
    (selectedEndpoint.queryFields || []).forEach((field) => {
      const value = explorerQuery[field];
      if (value !== undefined && value !== '') params.set(field, String(value));
    });
    const qs = params.toString();
    return `${V1_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  }

  async function runExplorerRequest(e) {
    e.preventDefault();
    setExplorerBusy(true);
    setExplorerError('');
    setExplorerResponse('');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (selectedEndpoint.auth) {
        if (!explorerApiKey) {
          throw new Error('API key required for this endpoint');
        }
        headers.Authorization = `Bearer ${explorerApiKey}`;
      }
      const options = {
        method: selectedEndpoint.method,
        headers: selectedEndpoint.method === 'GET' ? (explorerApiKey && selectedEndpoint.auth ? { Authorization: headers.Authorization } : undefined) : headers,
      };
      if (selectedEndpoint.method !== 'GET' && selectedEndpoint.bodyTemplate) {
        options.body = explorerBody;
      }
      const res = await fetch(buildExplorerUrl(), options);
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      setExplorerResponse(JSON.stringify({ status: res.status, body: parsed }, null, 2));
    } catch (err) {
      setExplorerError(err.message || 'Request failed');
    } finally {
      setExplorerBusy(false);
    }
  }

  return (
    <main className="container" style={{ paddingTop: '3rem', paddingBottom: '4rem', maxWidth: '900px' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.35rem' }}>Developer</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem', fontSize: '0.95rem' }}>
        API keys and webhooks for integrating CrowdPay as a funding backend. Public API documentation:{' '}
        <a href="/v1/docs" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          OpenAPI /v1/docs
        </a>
        . See <code style={{ fontSize: '0.85rem' }}>backend/docs/webhooks-integration.md</code> for HMAC verification.
      </p>
      {error && <p style={{ color: 'var(--color-status-error)', marginBottom: '1rem' }}>{error}</p>}
      {loading && <p style={{ color: 'var(--color-text-hint)' }}>Loading…</p>}

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>API explorer</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--color-text-hint)', marginBottom: '1rem' }}>
          Try public API v1 endpoints with your API key. Rate limit: 100 requests/minute per key.
        </p>
        <form onSubmit={runExplorerRequest} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '640px' }}>
          <label style={{ fontSize: '0.85rem' }}>
            Endpoint
            <select
              value={explorerEndpoint}
              onChange={(e) => setExplorerEndpoint(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
            >
              {V1_ENDPOINTS.map((ep) => (
                <option key={ep.id} value={ep.id}>{ep.label}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: '0.85rem' }}>
            API key {selectedEndpoint.auth ? '(required)' : '(optional)'}
            <input
              type="password"
              value={explorerApiKey}
              onChange={(e) => setExplorerApiKey(e.target.value)}
              placeholder="cp_live_…"
              style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
            />
          </label>
          {(selectedEndpoint.pathFields || []).map((field) => (
            <label key={field} style={{ fontSize: '0.85rem' }}>
              {field}
              <input
                value={explorerPathParams[field] || ''}
                onChange={(e) =>
                  setExplorerPathParams((cur) => ({ ...cur, [field]: e.target.value }))
                }
                style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
              />
            </label>
          ))}
          {(selectedEndpoint.queryFields || []).map((field) => (
            <label key={field} style={{ fontSize: '0.85rem' }}>
              Query: {field}
              <input
                value={explorerQuery[field] || ''}
                onChange={(e) =>
                  setExplorerQuery((cur) => ({ ...cur, [field]: e.target.value }))
                }
                style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
              />
            </label>
          ))}
          {selectedEndpoint.bodyTemplate && (
            <label style={{ fontSize: '0.85rem' }}>
              Request body (JSON)
              <textarea
                rows={5}
                value={explorerBody}
                onChange={(e) => setExplorerBody(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: '0.35rem', fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
            </label>
          )}
          <button type="submit" className="btn-primary" disabled={explorerBusy} style={{ alignSelf: 'flex-start', padding: '0.5rem 1rem' }}>
            {explorerBusy ? 'Sending…' : 'Send request'}
          </button>
        </form>
        {explorerError && <p style={{ color: 'var(--color-status-error)', marginTop: '0.75rem' }}>{explorerError}</p>}
        {explorerResponse && (
          <pre style={{ marginTop: '1rem', padding: '0.85rem', background: 'var(--color-border-lightest)', borderRadius: 8, overflow: 'auto', fontSize: '0.8rem' }}>
            {explorerResponse}
          </pre>
        )}
      </section>

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>API keys</h2>
        {revealedKey && (
          <div style={{ background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-border)', padding: '0.85rem', borderRadius: 8, marginBottom: '1rem' }}>
            <strong>Copy now:</strong>
            <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>{revealedKey}</pre>
          </div>
        )}
        <form onSubmit={createKey} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
          <input value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} placeholder="Label" style={{ minWidth: '160px' }} />
          <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>Scopes:</span>
          {SCOPE_OPTIONS.map((sc) => (
            <label key={sc} style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <input type="checkbox" checked={newKeyScopes.includes(sc)} onChange={() => toggleScope(sc)} />
              {sc}
            </label>
          ))}
          <button type="submit" className="btn-primary" style={{ padding: '0.45rem 0.9rem' }}>Create key</button>
        </form>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
              <th style={{ padding: '0.4rem' }}>Label</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.filter((k) => !k.revoked_at).map((k) => (
              <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border-lighter)' }}>
                <td style={{ padding: '0.45rem' }}>{k.label}</td>
                <td><code>{k.key_prefix}</code></td>
                <td>{(k.scopes || []).join(', ')}</td>
                <td style={{ color: 'var(--color-text-hint)' }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td>
                <td>
                  <button type="button" className="btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }} onClick={() => revokeKey(k.id)}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>Webhooks</h2>
        {revealedSecret && (
          <div style={{ background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-border)', padding: '0.85rem', borderRadius: 8, marginBottom: '1rem' }}>
            <strong>Signing secret (copy once):</strong>
            <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>{revealedSecret}</pre>
          </div>
        )}
        <form onSubmit={createHook} style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', maxWidth: '520px', marginBottom: '1rem' }}>
          <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://example.com/crowdpay-webhook" required />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {EVENT_OPTIONS.map((ev) => (
              <label key={ev} style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <input type="checkbox" checked={hookEvents.includes(ev)} onChange={() => toggleEvent(ev)} />
                {ev}
              </label>
            ))}
          </div>
          <button type="submit" className="btn-primary" style={{ padding: '0.5rem 1rem', alignSelf: 'flex-start' }}>Add endpoint</button>
        </form>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {hooks.filter((h) => !h.revoked_at).map((h) => (
            <li key={h.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--color-border-lighter)', display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{h.url}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>{(h.events || []).join(', ')} · {h.secret_hint}</div>
              </div>
              <button type="button" className="btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }} onClick={() => revokeHook(h.id)}>Remove</button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>Webhook delivery log</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
                <th style={{ padding: '0.35rem' }}>Time</th>
                <th>Event</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Attempts</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--color-border-lightest)' }}>
                  <td style={{ padding: '0.35rem', whiteSpace: 'nowrap' }}>{new Date(d.created_at).toLocaleString()}</td>
                  <td>{d.event_type}</td>
                  <td>{d.status}</td>
                  <td>{d.response_status ?? '—'}</td>
                  <td>{d.attempt_count}</td>
                  <td style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.last_error || ''}>{d.last_error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
