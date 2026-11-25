import { useCallback, useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { api } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { cardStyle } from './AdminShared';

export default function FraudQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [stats, setStats] = useState({
    false_positives: 0,
    true_positives: 0,
    false_positive_rate: 0,
  });
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cList, cStats] = await Promise.all([
        api.getAdminFraudCampaigns(),
        api.getAdminFraudStats(),
      ]);
      setCampaigns(cList);
      setStats(cStats);
    } catch (err) {
      toast?.('Failed to load fraud data. Please try again.', 'error');
      Sentry.captureException(err);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(id) {
    if (!window.confirm('Clear fraud flag and restore campaign status to active?')) return;
    try {
      await api.adminApproveFraudCampaign(id);
      await load();
    } catch (err) {
      window.alert(err.message || 'Could not approve campaign');
    }
  }

  async function freeze(id) {
    if (!window.confirm('Freeze campaign to block further contributions?')) return;
    try {
      await api.adminSuspendCampaign(id, { reason: 'Suspended due to high risk fraud signals.' });
      await load();
    } catch (err) {
      window.alert(err.message || 'Could not freeze campaign');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading fraud logs…</p>;

  return (
    <div>
      {/* Stats summary panel */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}
      >
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
            Flagged Campaigns
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>
            {campaigns.length}
          </div>
        </div>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
            True Positives (Frozen)
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>
            {stats.true_positives}
          </div>
        </div>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
            False Positives (Cleared)
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>
            {stats.false_positives}
          </div>
        </div>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
            False Positive Rate
          </div>
          <div
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              marginTop: '0.25rem',
              color: 'var(--color-accent)',
            }}
          >
            {(stats.false_positive_rate * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No active campaigns flagged for fraud.</p>
      ) : (
        <div style={{ display: 'grid', gap: '1rem', marginBottom: '2.5rem' }}>
          {campaigns.map((c) => {
            const signals = c.fraud_signals || {};
            return (
              <div key={c.id} style={{ ...cardStyle, borderLeft: '4px solid var(--color-danger)' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    marginBottom: '0.5rem',
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{c.title}</h3>
                    <div
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--color-text-hint)',
                        marginTop: '0.25rem',
                      }}
                    >
                      Creator: {c.creator_name} ({c.creator_email}) · ID:{' '}
                      <code>{c.id.slice(0, 8)}</code>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div
                      style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--color-danger)' }}
                    >
                      Score: {c.fraud_score}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>
                      Status:{' '}
                      <strong
                        style={{
                          color:
                            c.status === 'suspended'
                              ? 'var(--color-danger)'
                              : 'var(--color-success)',
                        }}
                      >
                        {c.status}
                      </strong>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    borderTop: '1px solid var(--color-border-light)',
                    paddingTop: '0.5rem',
                    margin: '0.5rem 0',
                  }}
                >
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                    Fraud Signals Breakdown:
                  </div>
                  <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.85rem' }}>
                    {Object.entries(signals).map(([key, value]) => (
                      <div
                        key={key}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '0.2rem 0.4rem',
                          background: 'var(--color-bg-secondary)',
                          borderRadius: '4px',
                        }}
                      >
                        <span style={{ textTransform: 'capitalize' }}>
                          <strong>{key.replace('_', ' ')}:</strong> {value.detail}
                        </span>
                        <span
                          style={{
                            fontWeight: 600,
                            color:
                              value.score > 0 ? 'var(--color-danger)' : 'var(--color-text-hint)',
                          }}
                        >
                          +{value.score}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                  <button
                    type="button"
                    onClick={() => approve(c.id)}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.35rem 0.8rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: 'var(--color-teal)',
                      color: '#fff',
                      border: 'none',
                    }}
                  >
                    Approve (Clear Flag)
                  </button>
                  {c.status !== 'suspended' && (
                    <button
                      type="button"
                      onClick={() => freeze(c.id)}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.35rem 0.8rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: 'var(--color-error-bg)',
                        color: 'var(--color-error-text)',
                        border: '1px solid var(--color-border-light)',
                      }}
                    >
                      Freeze Campaign
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
