import { useEffect, useState, useCallback } from 'react';
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

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'withdrawals', label: 'Withdrawals' },
  { id: 'disputes', label: 'Disputes' },
  { id: 'kyc', label: 'KYC' },
  { id: 'campaigns', label: 'Campaigns' },
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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '1.25rem',
            }}
          >
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

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading health data…</p>;

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Platform Health</h3>
      {health && (
        <div style={{ display: 'grid', gap: '0.5rem', fontSize: '0.9rem' }}>
          <div>Database: {health.database ? '✓ Connected' : '✗ Disconnected'}</div>
          <div>Stellar: {health.stellar ? '✓ Connected' : '✗ Disconnected'}</div>
          <div>Webhook failures: {webhooks.length}</div>
        </div>
      )}
    </div>
  );
}

function WithdrawalQueue() {
  return (
    <div style={cardStyle}>
      <p style={{ color: 'var(--color-text-hint)' }}>Withdrawal queue coming soon.</p>
    </div>
  );
}

function DisputeManagement() {
  return (
    <div style={cardStyle}>
      <p style={{ color: 'var(--color-text-hint)' }}>Dispute management coming soon.</p>
    </div>
  );
}

function KycOversight() {
  return (
    <div style={cardStyle}>
      <p style={{ color: 'var(--color-text-hint)' }}>KYC oversight coming soon.</p>
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
  }

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
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
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
