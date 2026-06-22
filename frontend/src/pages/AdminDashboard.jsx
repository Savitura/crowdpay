import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed'];
const KYC_STATUSES = ['unverified', 'pending', 'verified', 'rejected'];

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

const buttonStyle = {
  fontSize: '0.75rem',
  padding: '0.25rem 0.7rem',
  borderRadius: '6px',
  border: '1px solid var(--color-border-light)',
  background: 'var(--color-bg-secondary)',
  cursor: 'pointer',
};

function hintText(text) {
  return <p style={{ color: 'var(--color-text-hint)' }}>{text}</p>;
}

function WithdrawalQueue() {
  const [withdrawals, setWithdrawals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [events, setEvents] = useState({});

  function load() {
    setLoading(true);
    api.getAdminWithdrawals({ status: 'pending' })
      .then(setWithdrawals)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleExpand(id) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!events[id]) {
      try {
        const evs = await api.getWithdrawalEvents(id);
        setEvents((prev) => ({ ...prev, [id]: evs }));
      } catch {
        setEvents((prev) => ({ ...prev, [id]: [] }));
      }
    }
  }

  async function approve(id) {
    if (!window.confirm('Approve this withdrawal and submit to Stellar?')) return;
    setBusyId(id);
    try {
      await api.approveWithdrawalPlatform(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not approve withdrawal');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id) {
    const reason = window.prompt('Rejection reason (required):', '');
    if (!reason) return;
    setBusyId(id);
    try {
      await api.rejectWithdrawal(id, { reason });
      load();
    } catch (err) {
      alert(err.message || 'Could not reject withdrawal');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return hintText('Loading withdrawal queue…');
  if (!withdrawals.length) return <p style={{ color: 'var(--color-text-hint)', marginBottom: '2.5rem' }}>No pending withdrawals.</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {withdrawals.map((w) => (
        <div key={w.id} style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{w.campaign_title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                {w.requested_by_name} ({w.requested_by_email})
              </span>
            </div>
            <span style={badgeStyle}>{w.amount} {w.asset_type}</span>
          </div>
          <p style={{ margin: '0.5rem 0', fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
            Requested {new Date(w.created_at).toLocaleString()} · creator_signed: {String(w.creator_signed)} · platform_signed: {String(w.platform_signed)}
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button style={buttonStyle} onClick={() => toggleExpand(w.id)}>
              {expandedId === w.id ? 'Hide details' : 'Review'}
            </button>
            <button
              disabled={busyId === w.id || !w.creator_signed}
              onClick={() => approve(w.id)}
              style={{ ...buttonStyle, border: '1px solid #86efac', background: '#dcfce7', color: '#166534', opacity: busyId === w.id ? 0.5 : 1 }}
              title={!w.creator_signed ? 'Waiting on creator signature' : undefined}
            >
              Approve
            </button>
            <button
              disabled={busyId === w.id}
              onClick={() => reject(w.id)}
              style={{ ...buttonStyle, border: '1px solid #fca5a5', background: '#fee2e2', color: '#991b1b', opacity: busyId === w.id ? 0.5 : 1 }}
            >
              Reject
            </button>
          </div>

          {expandedId === w.id && (
            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--color-border-light)' }}>
              <p style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                <strong>Destination:</strong> {w.destination_key}
              </p>
              {w.denial_reason && (
                <p style={{ fontSize: '0.85rem' }}><strong>Denial reason:</strong> {w.denial_reason}</p>
              )}
              <p style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: '0.5rem' }}>Audit timeline</p>
              {!events[w.id] && <p style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Loading…</p>}
              {events[w.id]?.length === 0 && <p style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>No events yet.</p>}
              {events[w.id]?.map((e) => (
                <div key={e.id} style={{ fontSize: '0.8rem', padding: '0.25rem 0', borderBottom: '1px solid var(--color-border-light)' }}>
                  <strong>{e.action}</strong> — {new Date(e.created_at).toLocaleString()}
                  {e.note && <span> · {e.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DisputeQueue() {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [events, setEvents] = useState({});

  useEffect(() => {
    api.getAdminCampaigns()
      .then(async (campaigns) => {
        const all = await Promise.all(
          campaigns.map((c) =>
            api.getCampaignDisputes(c.id)
              .then((ds) => ds.map((d) => ({ ...d, campaign_title: c.title })))
              .catch(() => [])
          )
        );
        setDisputes(all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      })
      .finally(() => setLoading(false));
  }, []);

  async function toggleExpand(id) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!events[id]) {
      try {
        const evs = await api.getDisputeEvents(id);
        setEvents((prev) => ({ ...prev, [id]: evs }));
      } catch {
        setEvents((prev) => ({ ...prev, [id]: [] }));
      }
    }
  }

  async function resolve(dispute, status) {
    const note = window.prompt(`Resolution note (${status}):`, '');
    if (note === null) return;
    setBusyId(dispute.id);
    try {
      const updated = await api.updateDispute(dispute.id, { status, resolution_note: note || undefined });
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
    } catch (err) {
      alert(err.message || 'Could not update dispute');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return hintText('Loading disputes…');
  if (!disputes.length) return <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>No disputes on record.</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {disputes.map((d) => (
        <div key={d.id} style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{d.campaign_title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                #{d.id}
              </span>
            </div>
            <span style={badgeStyle}>{d.status}</span>
          </div>

          <p style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>{d.reason}</p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <button style={buttonStyle} onClick={() => toggleExpand(d.id)}>
              {expandedId === d.id ? 'Hide details' : 'Review'}
            </button>
            {!['resolved_creator', 'resolved_contributor', 'closed'].includes(d.status) && (
              <>
                <button
                  disabled={busyId === d.id}
                  onClick={() => resolve(d, 'resolved_contributor')}
                  style={{ ...buttonStyle, border: '1px solid #86efac', background: '#dcfce7', color: '#166534', opacity: busyId === d.id ? 0.5 : 1 }}
                >
                  Resolve in favor of contributor
                </button>
                <button
                  disabled={busyId === d.id}
                  onClick={() => resolve(d, 'resolved_creator')}
                  style={{ ...buttonStyle, opacity: busyId === d.id ? 0.5 : 1 }}
                >
                  Resolve in favor of creator
                </button>
                {d.status !== 'under_review' && (
                  <button
                    disabled={busyId === d.id}
                    onClick={() => resolve(d, 'under_review')}
                    style={{ ...buttonStyle, border: '1px solid #fde047', background: '#fef9c3', color: '#854d0e', opacity: busyId === d.id ? 0.5 : 1 }}
                  >
                    Escalate
                  </button>
                )}
              </>
            )}
          </div>

          {expandedId === d.id && (
            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--color-border-light)' }}>
              <p style={{ fontSize: '0.85rem' }}><strong>Description:</strong> {d.description}</p>
              {d.evidence_url && (
                <p style={{ fontSize: '0.85rem' }}>
                  <strong>Evidence:</strong> <a href={d.evidence_url} target="_blank" rel="noreferrer">{d.evidence_url}</a>
                </p>
              )}
              {d.resolution_note && (
                <p style={{ fontSize: '0.85rem' }}><strong>Resolution note:</strong> {d.resolution_note}</p>
              )}
              <p style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: '0.5rem' }}>Timeline</p>
              {!events[d.id] && <p style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Loading…</p>}
              {events[d.id]?.map((e) => (
                <div key={e.id} style={{ fontSize: '0.8rem', padding: '0.25rem 0', borderBottom: '1px solid var(--color-border-light)' }}>
                  <strong>{e.action}</strong> by {e.actor_name || 'system'} — {new Date(e.created_at).toLocaleString()}
                  {e.note && <span> · {e.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function KycPanel() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    api.getAdminUsersKyc(filter ? { status: filter } : {})
      .then(setUsers)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function override(user, kyc_status) {
    const note = window.prompt(`Note for setting KYC status to "${kyc_status}" (optional):`, '');
    if (note === null) return;
    setBusyId(user.id);
    try {
      await api.adminOverrideKyc(user.id, { kyc_status, note: note || undefined });
      load();
    } catch (err) {
      alert(err.message || 'Could not update KYC status');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button style={{ ...buttonStyle, fontWeight: filter === '' ? 700 : 400 }} onClick={() => setFilter('')}>All</button>
        {KYC_STATUSES.map((s) => (
          <button key={s} style={{ ...buttonStyle, fontWeight: filter === s ? 700 : 400 }} onClick={() => setFilter(s)}>
            {s}
          </button>
        ))}
      </div>

      {loading ? hintText('Loading users…') : !users.length ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No users match this filter.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.7rem' }}>
          {users.map((u) => (
            <div key={u.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div>
                  <strong>{u.name}</strong>
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>{u.email}</span>
                </div>
                <span style={badgeStyle}>{u.kyc_status}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  disabled={busyId === u.id || u.kyc_status === 'verified'}
                  onClick={() => override(u, 'verified')}
                  style={{ ...buttonStyle, border: '1px solid #86efac', background: '#dcfce7', color: '#166534', opacity: busyId === u.id ? 0.5 : 1 }}
                >
                  Mark verified
                </button>
                <button
                  disabled={busyId === u.id || u.kyc_status === 'pending'}
                  onClick={() => override(u, 'pending')}
                  style={{ ...buttonStyle, opacity: busyId === u.id ? 0.5 : 1 }}
                >
                  Force re-verification
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlatformHealthPanel() {
  const [panel, setPanel] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    Promise.all([api.getAdminHealthPanel(), api.getAdminFailedWebhookDeliveries()])
      .then(([p, d]) => {
        setPanel(p);
        setDeliveries(d);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function retry(delivery) {
    setBusyId(delivery.id);
    try {
      await api.adminRetryWebhookDelivery(delivery.kind, delivery.id);
      load();
    } catch (err) {
      alert(err.message || 'Could not retry delivery');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return hintText('Loading platform health…');
  if (!panel) return <p style={{ color: 'var(--color-text-hint)' }}>Could not load platform health.</p>;

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <div style={cardStyle}><div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Active campaigns</div><strong>{panel.active_campaigns}</strong></div>
        <div style={cardStyle}><div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Total raised</div><strong>{panel.total_raised}</strong></div>
        <div style={cardStyle}><div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Pending withdrawals</div><strong>{panel.pending_withdrawals.count} ({panel.pending_withdrawals.total_value})</strong></div>
        <div style={cardStyle}><div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Open disputes</div><strong>{panel.open_disputes}</strong></div>
      </div>

      <h3 style={{ marginBottom: '0.5rem' }}>Stellar network status</h3>
      <div style={{ ...cardStyle, marginBottom: '1.5rem' }}>
        {panel.stellar.unavailable ? (
          <p style={{ color: 'var(--color-text-hint)' }}>Horizon status unavailable (request timed out).</p>
        ) : (
          <p style={{ fontSize: '0.9rem' }}>
            Ledger #{panel.stellar.current_ledger} · base fee {panel.stellar.base_fee_stroops} stroops · Horizon latency {panel.stellar.horizon_latency_ms}ms
          </p>
        )}
      </div>

      <h3 style={{ marginBottom: '0.5rem' }}>Recent reconciliation runs</h3>
      <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {!panel.recent_reconciliation_runs.length && <p style={{ color: 'var(--color-text-hint)' }}>No reconciliation runs recorded yet.</p>}
        {panel.recent_reconciliation_runs.map((r) => (
          <div key={r.id} style={{ ...cardStyle, padding: '0.6rem 0.9rem', fontSize: '0.85rem' }}>
            {new Date(r.finished_at).toLocaleString()} — checked {r.campaigns_checked} campaigns, {r.mismatches_found} mismatch(es)
          </div>
        ))}
      </div>

      <h3 style={{ marginBottom: '0.5rem' }}>Failed webhook deliveries ({panel.failed_webhook_deliveries})</h3>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {!deliveries.length && <p style={{ color: 'var(--color-text-hint)' }}>No failed deliveries.</p>}
        {deliveries.map((d) => (
          <div key={`${d.kind}-${d.id}`} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.85rem' }}>
              <strong>{d.event}</strong> ({d.kind}) → {d.webhook_url}
              <div style={{ color: 'var(--color-text-hint)' }}>{d.last_error}</div>
            </div>
            <button disabled={busyId === d.id} style={{ ...buttonStyle, opacity: busyId === d.id ? 0.5 : 1 }} onClick={() => retry(d)}>
              Retry
            </button>
          </div>
        ))}
      </div>
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
    api.getAdminCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));
  }

  async function feature(id) {
    const note = window.prompt('Featured note (optional):', '');
    if (note === null) return;
    try {
      await api.adminFeatureCampaign(id, { note });
      load();
    } catch (err) {
      alert(err.message || 'Could not feature campaign');
    }
  }

  async function unfeature(id) {
    if (!window.confirm('Remove from featured?')) return;
    try {
      await api.adminUnfeatureCampaign(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not unfeature campaign');
    }
  }

  if (loading) return hintText('Loading campaigns…');

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {campaigns.map((c) => (
        <div key={c.id} style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{c.title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                #{c.id}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => feature(c.id)}
                style={{ ...buttonStyle, border: '1px solid #fde047', background: '#fef9c3', color: '#854d0e' }}
              >
                ⭐️ Feature
              </button>
              <button onClick={() => unfeature(c.id)} style={buttonStyle}>
                Unfeature
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const TABS = [
  { key: 'campaigns', label: 'Campaigns', Component: CampaignsQueue },
  { key: 'withdrawals', label: 'Withdrawals', Component: WithdrawalQueue },
  { key: 'disputes', label: 'Disputes', Component: DisputeQueue },
  { key: 'kyc', label: 'KYC', Component: KycPanel },
  { key: 'health', label: 'Health', Component: PlatformHealthPanel },
];

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('campaigns');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  const Active = TABS.find((t) => t.key === activeTab)?.Component;

  return (
    <div style={{ maxWidth: '960px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Admin Dashboard</h1>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap', borderBottom: '1px solid var(--color-border-light)', paddingBottom: '0.75rem' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              ...buttonStyle,
              border: activeTab === t.key ? '1px solid var(--color-accent)' : '1px solid var(--color-border-light)',
              background: activeTab === t.key ? 'var(--color-accent-soft)' : 'var(--color-bg-secondary)',
              color: activeTab === t.key ? 'var(--color-accent)' : 'inherit',
              fontWeight: activeTab === t.key ? 700 : 400,
              padding: '0.4rem 0.9rem',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {Active && <Active />}
    </div>
  );
}
