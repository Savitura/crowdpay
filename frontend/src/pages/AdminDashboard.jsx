import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import RelativeTime from '../components/RelativeTime';

const DISPUTE_STATUSES = [
  'open',
  'under_review',
  'resolved_creator',
  'resolved_contributor',
  'closed',
];

const cardStyle = {
  border: '1px solid var(--color-border-light)',
  borderRadius: '12px',
  padding: '1rem',
  background: 'var(--color-bg)',
};

const badgeStyle = {
  fontSize: '0.75rem',
  padding: '0.2rem 0.6rem',
  borderRadius: '999px',
  background: 'var(--color-accent-soft)',
  color: 'var(--color-accent)',
};

function Drawer({ title, onClose, children }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(520px, 100%)',
          height: '100%',
          background: 'var(--color-bg)',
          borderLeft: '1px solid var(--color-border-light)',
          padding: '1.25rem',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{title}</h2>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.25rem' }}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PlatformHealthPanel() {
  const [health, setHealth] = useState(null);
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.getAdminHealth(), api.getAdminWebhookDeliveries({ status: 'failed', limit: 10 })])
      .then(([h, w]) => {
        setHealth(h);
        setWebhooks(w);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Load open/under_review disputes across all campaigns via admin endpoint
    api
      .getAdminCampaigns()
      .then(async (campaigns) => {
        const all = await Promise.all(
          campaigns.map((c) =>
            api
              .getCampaignDisputes(c.id)
              .then((ds) => ds.map((d) => ({ ...d, campaign_title: c.title })))
              .catch(() => [])
          )
        );
        setDisputes(all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openReview(row) {
    setReview(row);
    setError('');
    setRejectReason('');
    try {
      const [wr, ev, contribs] = await Promise.all([
        api.getWithdrawal(row.id),
        api.getWithdrawalEvents(row.id),
        api.getAdminCampaignContributions(row.campaign_id, { limit: 15 }),
      ]);
      setDetail(wr);
      setEvents(ev);
      setContributions(contribs);
    } catch (err) {
      setError(err.message || 'Could not load withdrawal details');
    }
  }

  function closeReview() {
    setReview(null);
    setDetail(null);
    setEvents([]);
    setContributions([]);
    setRejectReason('');
    setError('');
  }

  async function approve() {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.updateDispute(dispute.id, {
        status,
        resolution_note: note || undefined,
      });
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
    } catch (err) {
      window.alert(err.message || 'Could not update dispute');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading disputes…</p>;
  if (!disputes.length)
    return (
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>
        No disputes on record.
      </p>
    );

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
              <strong>{d.campaign_title}</strong>
              <span
                style={{
                  marginLeft: '0.5rem',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-hint)',
                }}
              >
                #{d.id}
              </span>
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
              <a href={m.evidence_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
                View proof
              </a>
            </p>
          )}

          <div style={{ marginTop: '0.45rem', fontSize: '0.82rem', color: 'var(--color-text-hint)' }}>
            Release: {Number(m.release_percentage).toLocaleString()}% · Destination:{' '}
            <code>{m.destination_key?.slice(0, 8)}…</code>
            {m.evidence_submitted_at && (
              <span> · Submitted {new Date(m.evidence_submitted_at).toLocaleString()}</span>
            )}
          </div>

          {rejectingId === m.id ? (
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Rejection reason (visible to creator)"
                rows={2}
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
                  border: '1px solid #86efac',
                  background: '#dcfce7',
                  color: '#166534',
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

function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, []);

  function load() {
    api
      .getAdminCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));
  }, []);

  async function feature(id) {
    const note = window.prompt('Featured note (optional):', '');
    if (note === null) return;
    try {
      await api.adminFeatureCampaign(id, { note });
      const updated = await api.getAdminCampaigns();
      setCampaigns(updated);
    } catch (err) {
      window.alert(err.message || 'Could not feature campaign');
    }
  }

  async function unfeature(id) {
    if (!window.confirm('Remove from featured?')) return;
    try {
      await api.adminUnfeatureCampaign(id);
      const updated = await api.getAdminCampaigns();
      setCampaigns(updated);
    } catch (err) {
      window.alert(err.message || 'Could not unfeature campaign');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading campaigns…</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {campaigns.map((c) => (
        <div key={c.id} style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div>
              <strong>{c.title}</strong>
              <span
                style={{
                  marginLeft: '0.5rem',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-hint)',
                }}
              >
                #{c.id}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => feature(c.id)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid #fde047',
                  background: '#fef9c3',
                  color: '#854d0e',
                  cursor: 'pointer',
                }}
              >
                ⭐️ Feature
              </button>
              <button
                onClick={() => unfeature(c.id)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary)',
                  cursor: 'pointer',
                }}
              >
                Unfeature
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (!user || (user.role !== 'admin' && !user.is_admin)) {
      navigate('/');
    }
  }, [user, navigate]);

  return (
    <div style={{ maxWidth: '860px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Admin Dashboard</h1>

      <h2 style={{ marginBottom: '1rem' }}>Campaigns</h2>
      <CampaignsQueue />

      <h2 style={{ marginBottom: '1rem', marginTop: '2rem' }}>Dispute Queue</h2>
      <DisputeQueue />
    <div style={{ maxWidth: '960px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Admin Dashboard</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Withdrawal approvals, dispute management, KYC oversight, and platform health.
      </p>

      <nav style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              ...badgeStyle,
              cursor: 'pointer',
              background: tab === t.id ? 'var(--color-accent)' : 'var(--color-accent-soft)',
              color: tab === t.id ? '#fff' : 'var(--color-accent)',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <PlatformHealthPanel />}
      {tab === 'withdrawals' && <WithdrawalQueue />}
      {tab === 'disputes' && <DisputeManagement />}
      {tab === 'kyc' && <KycOversight />}
      {tab === 'campaigns' && <CampaignsQueue />}
    </div>
  );
}
