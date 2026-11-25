import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import { badgeStyle } from './AdminShared';

export default function AuditLogViewer() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({
    actor: '',
    action: '',
    resource_type: '',
    start_date: '',
    end_date: '',
  });
  const PAGE_SIZE = 50;

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (filters.actor) params.actor = filters.actor;
    if (filters.action) params.action = filters.action;
    if (filters.resource_type) params.resource_type = filters.resource_type;
    if (filters.start_date) params.start_date = filters.start_date;
    if (filters.end_date) params.end_date = filters.end_date;

    api
      .getAdminAuditLogs(params)
      .then((res) => {
        setLogs(res.data);
        setTotal(res.total);
      })
      .catch(() => {
        setLogs([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [page, filters]);

  useEffect(() => {
    load();
  }, [load]);

  function applyFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }

  function resetFilters() {
    setFilters({ actor: '', action: '', resource_type: '', start_date: '', end_date: '' });
    setPage(0);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportCsv() {
    try {
      const res = await api.exportAdminAuditLogsCsv(filters);
      downloadBlob(res.blob, res.filename);
    } catch (err) {
      alert(err.message || 'CSV export failed');
    }
  }

  async function exportJson() {
    try {
      const res = await api.exportAdminAuditLogsJson(filters);
      downloadBlob(res.blob, res.filename);
    } catch (err) {
      alert(err.message || 'JSON export failed');
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: '0.6rem',
          marginBottom: '1rem',
          fontSize: '0.85rem',
        }}
      >
        <input
          type="text"
          placeholder="Actor (email or id)"
          value={filters.actor}
          onChange={(e) => applyFilter('actor', e.target.value)}
          style={{
            padding: '0.4rem 0.5rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
          }}
        />
        <input
          type="text"
          placeholder="Action (exact match)"
          value={filters.action}
          onChange={(e) => applyFilter('action', e.target.value)}
          style={{
            padding: '0.4rem 0.5rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
          }}
        />
        <input
          type="text"
          placeholder="Resource type"
          value={filters.resource_type}
          onChange={(e) => applyFilter('resource_type', e.target.value)}
          style={{
            padding: '0.4rem 0.5rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
          }}
        />
        <input
          type="date"
          placeholder="Start date"
          value={filters.start_date}
          onChange={(e) => applyFilter('start_date', e.target.value)}
          style={{
            padding: '0.4rem 0.5rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
          }}
        />
        <input
          type="date"
          placeholder="End date"
          value={filters.end_date}
          onChange={(e) => applyFilter('end_date', e.target.value)}
          style={{
            padding: '0.4rem 0.5rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
          }}
        />
        <button
          type="button"
          onClick={resetFilters}
          style={{
            padding: '0.4rem 0.6rem',
            borderRadius: '6px',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg-secondary)',
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
        >
          Reset
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={exportCsv}
          style={{
            padding: '0.4rem 0.7rem',
            borderRadius: '6px',
            border: '1px solid var(--color-accent)',
            background: 'var(--color-accent-soft)',
            color: 'var(--color-accent)',
            cursor: 'pointer',
            fontSize: '0.8rem',
          }}
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={exportJson}
          style={{
            padding: '0.4rem 0.7rem',
            borderRadius: '6px',
            border: '1px solid var(--color-accent)',
            background: 'var(--color-accent-soft)',
            color: 'var(--color-accent)',
            cursor: 'pointer',
            fontSize: '0.8rem',
          }}
        >
          Export JSON
        </button>
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
          {total.toLocaleString()} result{total !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading audit logs…</p>
      ) : logs.length === 0 ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No audit log entries match your filters.</p>
      ) : (
        <>
          <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr
                  style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}
                >
                  <th style={{ padding: '0.45rem 0.5rem' }}>Timestamp</th>
                  <th style={{ padding: '0.45rem 0.5rem' }}>Actor</th>
                  <th style={{ padding: '0.45rem 0.5rem' }}>Action</th>
                  <th style={{ padding: '0.45rem 0.5rem' }}>Resource</th>
                  <th style={{ padding: '0.45rem 0.5rem' }}>IP</th>
                  <th style={{ padding: '0.45rem 0.5rem' }}>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                    <td style={{ padding: '0.45rem 0.5rem', whiteSpace: 'nowrap' }}>
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: '0.45rem 0.5rem' }}>
                      {row.actor_email || row.actor_id || '—'}
                    </td>
                    <td style={{ padding: '0.45rem 0.5rem' }}>
                      <span style={badgeStyle}>{row.action}</span>
                    </td>
                    <td style={{ padding: '0.45rem 0.5rem' }}>
                      {row.resource_type}
                      {row.resource_id && (
                        <code style={{ marginLeft: '0.3rem', fontSize: '0.75rem' }}>
                          {String(row.resource_id).slice(0, 8)}
                        </code>
                      )}
                    </td>
                    <td style={{ padding: '0.45rem 0.5rem', fontSize: '0.78rem' }}>
                      {row.ip_address || '—'}
                    </td>
                    <td style={{ padding: '0.45rem 0.5rem' }}>
                      {row.metadata && Object.keys(row.metadata).length > 0 ? (
                        <details>
                          <summary style={{ cursor: 'pointer', fontSize: '0.78rem' }}>view</summary>
                          <pre
                            style={{
                              fontSize: '0.7rem',
                              background: 'var(--color-bg-secondary)',
                              padding: '0.4rem',
                              borderRadius: '4px',
                              maxHeight: '120px',
                              overflow: 'auto',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                            }}
                          >
                            {JSON.stringify(row.metadata, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div
              style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}
            >
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                style={{
                  padding: '0.35rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg)',
                  cursor: page === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  opacity: page === 0 ? 0.5 : 1,
                }}
              >
                ← Previous
              </button>
              <span
                style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', alignSelf: 'center' }}
              >
                Page {page + 1} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                style={{
                  padding: '0.35rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg)',
                  cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  opacity: page >= totalPages - 1 ? 0.5 : 1,
                }}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
