import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import RelativeTime from '../RelativeTime';
import { cardStyle } from './AdminShared';

export default function PlatformHealthPanel() {
  const [health, setHealth] = useState(null);
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getAdminHealth(),
      api.getAdminWebhookDeliveries({ status: 'failed', limit: 10 }),
    ])
      .then(([h, w]) => {
        setHealth(h);
        setWebhooks(w);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function retryDelivery(delivery) {
    setRetryingId(delivery.id);
    try {
      await api.adminRetryWebhookDelivery(delivery.id, { kind: delivery.delivery_kind });
      load();
    } catch (err) {
      alert(err.message || 'Retry failed');
    } finally {
      setRetryingId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading platform health…</p>;
  if (!health)
    return <p style={{ color: 'var(--color-text-hint)' }}>Could not load health data.</p>;

  return (
    <div style={{ display: 'grid', gap: '1rem', marginBottom: '2rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {[
          { label: 'Active campaigns', value: health.active_campaigns },
          { label: 'Total raised', value: `${Number(health.total_raised).toLocaleString()}` },
          {
            label: 'Pending withdrawals',
            value: `${health.pending_withdrawals.count} (${Number(health.pending_withdrawals.total_value).toLocaleString()})`,
          },
          { label: 'Open disputes', value: health.open_disputes },
          { label: 'Failed webhooks', value: health.failed_webhook_deliveries },
        ].map((stat) => (
          <div key={stat.label} style={{ ...cardStyle, textAlign: 'center' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>{stat.label}</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '0.25rem' }}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Stellar network</h3>
        {health.stellar?.error ? (
          <p style={{ color: 'var(--color-danger)', margin: 0 }}>{health.stellar.error}</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.9rem' }}>
            <div>
              Network: <strong>{health.stellar.network}</strong>
            </div>
            <div>
              Current ledger: <strong>{health.stellar.current_ledger}</strong>
            </div>
            <div>
              Base fee: <strong>{health.stellar.base_fee_stroops} stroops</strong>
            </div>
            <div>
              Horizon latency: <strong>{health.stellar.horizon_latency_ms} ms</strong>
            </div>
          </div>
        )}
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)', margin: '0.75rem 0 0' }}>
          Panel loaded in {health.load_time_ms} ms
        </p>
      </div>

      {health.recent_reconciliation_runs?.length > 0 && (
        <div style={cardStyle}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Recent reconciliation runs</h3>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.85rem' }}>
            {health.recent_reconciliation_runs.map((run) => (
              <li key={run.started_at} style={{ marginBottom: '0.4rem' }}>
                <RelativeTime date={run.started_at} /> — checked {run.campaigns_checked}, updated{' '}
                {run.updated}, skipped {run.skipped}, errors {run.errors}
              </li>
            ))}
          </ul>
        </div>
      )}

      {webhooks.length > 0 && (
        <div style={cardStyle}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Failed webhook deliveries</h3>
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {webhooks.map((d) => (
              <div
                key={`${d.delivery_kind}-${d.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  fontSize: '0.85rem',
                }}
              >
                <div>
                  <strong>{d.event_type}</strong>
                  <div style={{ color: 'var(--color-text-hint)' }}>{d.webhook_url}</div>
                  {d.last_error && (
                    <div style={{ color: 'var(--color-danger)' }}>{d.last_error}</div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={retryingId === d.id}
                  onClick={() => retryDelivery(d)}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.25rem 0.7rem',
                    borderRadius: '6px',
                    cursor: 'pointer',
                  }}
                >
                  {retryingId === d.id ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
