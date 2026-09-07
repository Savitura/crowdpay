/* eslint-disable */
import { useEffect, useState, useCallback, useRef } from 'react';
import * as Sentry from '@sentry/react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import RelativeTime from '../components/RelativeTime';
import DisputeResolveModal from '../components/DisputeResolveModal';
import { useToast } from '../context/ToastContext';

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
  { id: 'milestones', label: 'Milestones' },
  { id: 'fraud', label: 'Fraud Detection' },
  { id: 'audit', label: 'Audit Log' },
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
  const panelRef = useRef(null);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    function trapTab(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
      else { if (document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }
    panel.addEventListener('keydown', trapTab);
    return () => panel.removeEventListener('keydown', trapTab);
  }, [children]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
        ref={panelRef}
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

function WithdrawalQueue() {
  return (
    <>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>
          No pending withdrawal requests.
        </p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: '2rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr
                style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}
              >
                <th style={{ padding: '0.5rem' }}>Campaign</th>
                <th style={{ padding: '0.5rem' }}>Creator</th>
                <th style={{ padding: '0.5rem' }}>Amount</th>
                <th style={{ padding: '0.5rem' }}>Requested</th>
                <th style={{ padding: '0.5rem' }}>Status</th>
                <th style={{ padding: '0.5rem' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: '0.5rem' }}>{row.campaign_title}</td>
                  <td style={{ padding: '0.5rem' }}>{row.creator_name}</td>
                  <td style={{ padding: '0.5rem' }}>
                    {Number(row.amount).toLocaleString()} {row.asset_type}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <RelativeTime date={row.created_at} />
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    {!row.creator_signed ? 'Awaiting creator' : 'Awaiting platform'}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => openReview(row)}
                      style={{ fontSize: '0.8rem', cursor: 'pointer' }}
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {review && (
        <Drawer title="Withdrawal review" onClose={closeReview}>
          {error && <p className="alert alert--error">{error}</p>}
          <div style={{ display: 'grid', gap: '0.75rem', fontSize: '0.9rem' }}>
            <div>
              <strong>Campaign:</strong> {review.campaign_title}
            </div>
            <div>
              <strong>Creator:</strong> {review.creator_name} ({review.creator_email})
            </div>
            <div>
              <strong>Amount:</strong> {Number(review.amount).toLocaleString()} {review.asset_type}
            </div>
            <div>
              <strong>Destination:</strong> <code>{review.destination_key}</code>
            </div>
            <div>
              <strong>Signatures:</strong> Creator {review.creator_signed ? '✓' : '—'} · Platform{' '}
              {review.platform_signed ? '✓' : '—'}
            </div>

            {detail?.unsigned_xdr && (
              <div>
                <strong>XDR preview</strong>
                <pre
                  style={{
                    fontSize: '0.7rem',
                    overflow: 'auto',
                    maxHeight: '120px',
                    background: 'var(--color-bg-secondary)',
                    padding: '0.5rem',
                    borderRadius: '6px',
                  }}
                >
                  {detail.unsigned_xdr}
                </pre>
              </div>
            )}

            <div>
              <strong>Contributor audit trail</strong>
              {contributions.length === 0 ? (
                <p style={{ color: 'var(--color-text-hint)', margin: '0.25rem 0' }}>
                  No contributions recorded.
                </p>
              ) : (
                <ul style={{ margin: '0.25rem 0', paddingLeft: '1.1rem' }}>
                  {contributions.map((c) => (
                    <li key={c.id}>
                      {c.contributor_name || c.sender_public_key?.slice(0, 8)} —{' '}
                      {Number(c.amount).toLocaleString()} {c.asset}
                      {c.contributor_kyc_status && (
                        <span style={{ marginLeft: '0.35rem', color: 'var(--color-text-hint)' }}>
                          (KYC: {c.contributor_kyc_status})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <strong>Event timeline</strong>
              {events.length === 0 ? (
                <p style={{ color: 'var(--color-text-hint)', margin: '0.25rem 0' }}>
                  No events yet.
                </p>
              ) : (
                <ol style={{ margin: '0.25rem 0', paddingLeft: '1.1rem' }}>
                  {events.map((ev) => (
                    <li key={ev.id}>
                      <strong>{ev.action}</strong>
                      {ev.note ? ` — ${ev.note}` : ''} (<RelativeTime date={ev.created_at} />)
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {canApprove && review.creator_signed && !review.platform_signed && (
              <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn-primary" disabled={busy} onClick={approve}>
                  {busy ? 'Approving…' : 'Approve & submit to Stellar'}
                </button>
                <label className="label-strong" htmlFor="reject-reason">
                  Rejection reason (required)
                </label>
                <textarea
                  id="reject-reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  placeholder="Explain why this withdrawal is rejected…"
                />
                <button type="button" className="btn-secondary" disabled={busy} onClick={reject}>
                  Reject withdrawal
                </button>
              </div>
            )}
            {canApprove && !review.creator_signed && (
              <p className="alert alert--info">
                Creator must sign before platform can approve or reject.
              </p>
            )}
            {!canApprove && (
              <p className="alert alert--info">
                You are not the designated platform approver for Stellar signatures.
              </p>
            )}
          </div>
        </Drawer>
      )}
    </>
  );
}

function DisputeManagement() {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [resolveOpen, setResolveOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getAdminDisputes()
      .then(setDisputes)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openDispute(dispute) {
    setSelected(dispute);
    try {
      const data = await api.getAdminDispute(dispute.id);
      setDetail(data);
    } catch (err) {
      alert(err.message || 'Could not load dispute');
    }
  }

  function closeDispute() {
    setSelected(null);
    setDetail(null);
    setResolveOpen(false);
  }

  async function handleResolve({ decision, reason }) {
    const updated = await api.decideDispute(selected.id, { decision, reason });
    setDisputes((prev) =>
      prev
        .map((d) => (d.id === updated.id ? { ...d, ...updated } : d))
        .filter((d) => ['open', 'under_review'].includes(d.status))
    );
    closeDispute();
  }

  async function escalate() {
    try {
      const updated = await api.updateDispute(selected.id, { status: 'under_review' });
      setDisputes((prev) =>
        prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d))
      );
      closeDispute();
    } catch (err) {
      alert(err.message || 'Could not escalate dispute');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading disputes…</p>;

  return (
    <>
      {disputes.length === 0 ? (
        <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>No open disputes.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: '2rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr
                style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}
              >
                <th style={{ padding: '0.5rem' }}>Campaign</th>
                <th style={{ padding: '0.5rem' }}>Parties</th>
                <th style={{ padding: '0.5rem' }}>Amount</th>
                <th style={{ padding: '0.5rem' }}>Evidence</th>
                <th style={{ padding: '0.5rem' }}>Status</th>
                <th style={{ padding: '0.5rem' }} />
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: '0.5rem' }}>{d.campaign_title}</td>
                  <td style={{ padding: '0.5rem' }}>
                    {d.reporter_name} vs {d.creator_name}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    {Number(d.amount_in_dispute || 0).toLocaleString()} {d.asset_type}
                  </td>
                  <td style={{ padding: '0.5rem' }}>{d.evidence_count || 0}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <span style={badgeStyle}>{d.status}</span>
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => openDispute(d)}
                      style={{ fontSize: '0.8rem', cursor: 'pointer' }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && detail && (
        <Drawer title={`Dispute #${selected.id.slice(0, 8)}`} onClose={closeDispute}>
          <div style={{ display: 'grid', gap: '0.75rem', fontSize: '0.9rem' }}>
            <div>
              <strong>Campaign:</strong> {detail.dispute.campaign_title}
            </div>
            <div>
              <strong>Reporter:</strong> {detail.dispute.reporter_name} (
              {detail.dispute.reporter_email})
            </div>
            <div>
              <strong>Creator:</strong> {detail.dispute.creator_name} (
              {detail.dispute.creator_email})
            </div>
            <div>
              <strong>Reason:</strong> {detail.dispute.reason}
            </div>
            <div>
              <strong>Description:</strong> {detail.dispute.description}
            </div>
            {detail.dispute.evidence_url && (
              <div>
                <strong>Evidence:</strong>{' '}
                <a href={detail.dispute.evidence_url} target="_blank" rel="noopener noreferrer">
                  {detail.dispute.evidence_url}
                </a>
              </div>
            )}

            {detail.evidence && detail.evidence.length > 0 && (
              <div>
                <strong>Submitted evidence ({detail.evidence.length})</strong>
                <div style={{ ...cardStyle, marginTop: '0.5rem', display: 'grid', gap: '0.6rem' }}>
                  {detail.evidence.map((ev) => (
                    <div key={ev.id} style={{ borderBottom: '1px solid var(--color-border-light)', paddingBottom: '0.5rem' }}>
                      <div style={{ fontWeight: 600, fontSize: '0.8rem', textTransform: 'capitalize' }}>
                        {ev.submitted_by_name || 'Unknown'} ({ev.role})
                      </div>
                      <div>{ev.text}</div>
                      {(ev.attachment_urls || []).map((url) => (
                        <div key={url}>
                          <a href={url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: 'break-all' }}>
                            {url}
                          </a>
                        </div>
                      ))}
                      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>
                        <RelativeTime date={ev.submitted_at} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <strong>Message thread</strong>
              <div
                style={{ ...cardStyle, marginTop: '0.5rem', maxHeight: '240px', overflowY: 'auto' }}
              >
                <div
                  style={{
                    marginBottom: '0.75rem',
                    paddingBottom: '0.75rem',
                    borderBottom: '1px solid var(--color-border-light)',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {detail.dispute.reporter_name} (initial report)
                  </div>
                  <div>{detail.dispute.description}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>
                    <RelativeTime date={detail.dispute.created_at} />
                  </div>
                </div>
                {detail.thread.map((msg) => (
                  <div key={msg.id} style={{ marginBottom: '0.75rem' }}>
                    <div style={{ fontWeight: 600 }}>
                      {msg.actor_name || 'System'} — {msg.action}
                    </div>
                    {msg.note && <div>{msg.note}</div>}
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>
                      <RelativeTime date={msg.created_at} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setResolveOpen(true)}
                style={{ fontSize: '0.85rem' }}
              >
                Resolve dispute…
              </button>
              <button
                type="button"
                onClick={escalate}
                style={{ fontSize: '0.8rem', cursor: 'pointer' }}
              >
                Escalate (under review)
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {resolveOpen && detail && (
        <DisputeResolveModal
          dispute={detail.dispute}
          thread={detail.thread}
          onClose={() => setResolveOpen(false)}
          onResolve={handleResolve}
        />
      )}
    </>
  );
}

function KycOversight() {
  const { updateUser } = useAuth();
  const navigate = useNavigate();
  const [kycFilter, setKycFilter] = useState('pending');
  const [users, setUsers] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.getAdminUsers({ kyc_status: kycFilter }), api.getAdminKycCampaigns()])
      .then(([u, c]) => {
        setUsers(u);
        setCampaigns(c);
      })
      .finally(() => setLoading(false));
  }, [kycFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function overrideKyc(userId, kyc_status) {
    const reason = window.prompt(`Reason for marking as ${kyc_status}:`, '');
    if (reason === null) return;
    setBusyId(userId);
    try {
      await api.adminUpdateUserKyc(userId, { kyc_status, reason: reason || undefined });
      load();
    } catch (err) {
      alert(err.message || 'KYC update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function impersonateUser(user) {
    setBusyId(user.id);
    try {
      await api.adminImpersonateUser(user.id);
      const userData = await api.getMe();
      updateUser(userData);
      navigate('/dashboard');
    } catch (err) {
      alert(err.message || 'Could not start impersonation');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading KYC data…</p>;

  return (
    <div style={{ display: 'grid', gap: '1.5rem', marginBottom: '2rem' }}>
      <div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {['pending', 'verified', 'rejected', 'unverified'].map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setKycFilter(status)}
              style={{
                ...badgeStyle,
                cursor: 'pointer',
                opacity: kycFilter === status ? 1 : 0.6,
                border:
                  kycFilter === status ? '1px solid var(--color-accent)' : '1px solid transparent',
              }}
            >
              {status}
            </button>
          ))}
        </div>

        {users.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)' }}>
            No users with status &ldquo;{kycFilter}&rdquo;.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {users.map((u) => (
              <div
                key={u.id}
                style={{
                  ...cardStyle,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <strong>{u.name}</strong> — {u.email}
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                    KYC: {u.kyc_status}
                    {u.kyc_completed_at && (
                      <>
                        {' '}
                        · verified <RelativeTime date={u.kyc_completed_at} />
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => impersonateUser(u)}
                    style={{ fontSize: '0.75rem' }}
                  >
                    View as user
                  </button>
                  {u.kyc_status !== 'verified' && (
                    <button
                      type="button"
                      disabled={busyId === u.id}
                      onClick={() => overrideKyc(u.id, 'verified')}
                      style={{ fontSize: '0.75rem' }}
                    >
                      Mark verified
                    </button>
                  )}
                  {u.kyc_status === 'verified' && (
                    <button
                      type="button"
                      disabled={busyId === u.id}
                      onClick={() => overrideKyc(u.id, 'unverified')}
                      style={{ fontSize: '0.75rem' }}
                    >
                      Force re-verification
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
          Campaigns with KYC-unverified contributors
        </h3>
        {campaigns.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)' }}>None found.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {campaigns.map((c) => (
              <li key={c.id} style={{ marginBottom: '0.35rem' }}>
                {c.title} — {c.unverified_contributor_count} unverified contributor
                {c.unverified_contributor_count !== 1 ? 's' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MilestonesQueue() {
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setLoading(true);
    api
      .getAdminMilestones({ status: 'pending_review' })
      .then(setMilestones)
      .catch(() => setMilestones([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function approve(milestone) {
    if (!window.confirm(`Approve and release funds for "${milestone.title}"?`)) return;
    setBusyId(milestone.id);
    try {
      await api.approveMilestone(milestone.id);
      load();
    } catch (err) {
      alert(err.message || 'Could not approve milestone');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(milestone) {
    const reason = rejectReason.trim();
    if (!reason) {
      alert('A rejection reason is required.');
      return;
    }
    setBusyId(milestone.id);
    try {
      await api.rejectMilestone(milestone.id, { reason });
      setRejectingId(null);
      setRejectReason('');
      load();
    } catch (err) {
      alert(err.message || 'Could not reject milestone');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading milestone queue…</p>;
  if (!milestones.length) {
    return (
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2.5rem' }}>
        No milestones awaiting evidence review.
      </p>
    );
  }

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
              <strong>{m.title}</strong>
              <div
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-hint)',
                  marginTop: '0.2rem',
                }}
              >
                {m.campaign_title} · {m.creator_name || m.creator_email}
              </div>
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
              <a
                href={m.evidence_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-accent)' }}
              >
                View proof
              </a>
            </p>
          )}

          <div
            style={{ marginTop: '0.45rem', fontSize: '0.82rem', color: 'var(--color-text-hint)' }}
          >
            Release: {Number(m.release_percentage).toLocaleString()}% · Destination:{' '}
            <code>{m.destination_key?.slice(0, 8)}…</code>
            {m.evidence_submitted_at && (
              <span> · Submitted {new Date(m.evidence_submitted_at).toLocaleString()}</span>
            )}
          </div>

          {rejectingId === m.id ? (
            <div
              style={{
                marginTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.45rem',
              }}
            >
              <label htmlFor={`milestone-reject-${m.id}`} className="sr-only">Rejection reason</label>
              <textarea
                id={`milestone-reject-${m.id}`}
                value={rejectReason}
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
                  border: '1px solid var(--color-success-border)',
                  background: 'var(--color-success-bg)',
                  color: 'var(--color-success-text)',
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

function ContractUpgradeModal({ campaign, onClose, onUpgraded }) {
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState(null);

  async function confirmUpgrade() {
    setUpgrading(true);
    setError(null);
    try {
      await api.adminUpgradeCampaignContract(campaign.id);
      onUpgraded();
    } catch (err) {
      setError(err.message || 'Could not upgrade contract');
    } finally {
      setUpgrading(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{ ...cardStyle, maxWidth: '420px', width: '90%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Upgrade Contract to V2</h3>
        <p style={{ fontSize: '0.9rem' }}>
          <strong>Campaign:</strong> {campaign.title}
        </p>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)', wordBreak: 'break-all' }}>
          <strong>Current contract:</strong> {campaign.escrow_contract_id}
        </p>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
          <strong>Estimated migration time:</strong> ~1&ndash;2 minutes
        </p>
        <p
          style={{
            fontSize: '0.85rem',
            padding: '0.6rem',
            borderRadius: '6px',
            background: 'var(--color-warning-bg, #fff3cd)',
            color: 'var(--color-warning-text, #7a5b00)',
          }}
        >
          Contributions and milestone submissions will be paused for this campaign until migration
          completes.
        </p>
        {error && (
          <p style={{ fontSize: '0.85rem', color: 'var(--color-error-text)' }}>{error}</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button type="button" onClick={onClose} disabled={upgrading}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmUpgrade}
            disabled={upgrading}
            style={{ background: 'var(--color-teal)', color: '#fff', border: 'none', borderRadius: '6px', padding: '0.4rem 0.8rem' }}
          >
            {upgrading ? 'Upgrading…' : 'Confirm Upgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [upgradeTarget, setUpgradeTarget] = useState(null);

  const reload = useCallback(() => {
    return api.getAdminCampaigns({ flagged_only: flaggedOnly }).then(setCampaigns);
  }, [flaggedOnly]);

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, [reload]);

  async function handleUpgraded() {
    setUpgradeTarget(null);
    await reload();
  }

  async function unflag(id) {
    if (!window.confirm('Remove duplicate flag and allow publishing?')) return;
    try {
      await api.adminUnflagCampaign(id);
      const updated = await api.getAdminCampaigns({ flagged_only: flaggedOnly });
      setCampaigns(updated);
    } catch (err) {
      window.alert(err.message || 'Could not unflag campaign');
    }
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
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600 }}>
          <input 
            type="checkbox" 
            checked={flaggedOnly} 
            onChange={(e) => setFlaggedOnly(e.target.checked)} 
          />
          Show flagged potential duplicates only
        </label>
      </div>
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
              {c.escrow_contract_id && (
                <span
                  title="Milestone escrow contract version"
                  style={{
                    marginLeft: '0.5rem',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    background: c.escrow_contract_version >= 2 ? 'var(--color-teal)' : 'var(--color-text-hint)',
                    color: '#fff',
                  }}
                >
                  {c.escrow_contract_version >= 2 ? 'V2' : 'V1'}
                </span>
              )}
              {c.is_flagged_duplicate && (
                <span
                  style={{
                    marginLeft: '0.5rem',
                    fontSize: '0.75rem',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    background: 'var(--color-error-bg)',
                    color: 'var(--color-error-text)',
                  }}
                >
                  Flagged Duplicate
                </span>
              )}
              <span
                style={{
                  marginLeft: '0.5rem',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-hint)',
                }}
              >
                {c.status} · #{c.id.slice(0, 8)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {c.is_flagged_duplicate ? (
                <button
                  type="button"
                  onClick={() => unflag(c.id)}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.25rem 0.7rem',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    background: 'var(--color-teal)',
                    color: '#fff',
                    border: 'none',
                  }}
                >
                  Unflag
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => feature(c.id)}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.25rem 0.7rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    Feature
                  </button>
                  <button
                    type="button"
                    onClick={() => unfeature(c.id)}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.25rem 0.7rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    Unfeature
                  </button>
                </>
              )}
              {c.escrow_contract_id && c.escrow_contract_version < 2 && !c.has_active_review && (
                <button
                  type="button"
                  onClick={() => setUpgradeTarget(c)}
                  disabled={c.migration_in_progress}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.25rem 0.7rem',
                    borderRadius: '6px',
                    cursor: c.migration_in_progress ? 'not-allowed' : 'pointer',
                  }}
                >
                  {c.migration_in_progress ? 'Migrating…' : 'Upgrade Contract'}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      </div>
      {upgradeTarget && (
        <ContractUpgradeModal
          campaign={upgradeTarget}
          onClose={() => setUpgradeTarget(null)}
          onUpgraded={handleUpgraded}
        />
      )}
    </div>
  );
}

function FraudQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [stats, setStats] = useState({ false_positives: 0, true_positives: 0, false_positive_rate: 0 });
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
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>Flagged Campaigns</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>{campaigns.length}</div>
        </div>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>True Positives (Frozen)</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>{stats.true_positives}</div>
        </div>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>False Positives (Cleared)</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>{stats.false_positives}</div>
        </div>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>False Positive Rate</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem', color: 'var(--color-accent)' }}>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{c.title}</h3>
                    <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', marginTop: '0.25rem' }}>
                      Creator: {c.creator_name} ({c.creator_email}) · ID: <code>{c.id.slice(0, 8)}</code>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--color-danger)' }}>
                      Score: {c.fraud_score}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-hint)' }}>
                      Status: <strong style={{ color: c.status === 'suspended' ? 'var(--color-danger)' : 'var(--color-success)' }}>{c.status}</strong>
                    </div>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--color-border-light)', paddingTop: '0.5rem', margin: '0.5rem 0' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Fraud Signals Breakdown:</div>
                  <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.85rem' }}>
                    {Object.entries(signals).map(([key, value]) => (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0.4rem', background: 'var(--color-bg-secondary)', borderRadius: '4px' }}>
                        <span style={{ textTransform: 'capitalize' }}>
                          <strong>{key.replace('_', ' ')}:</strong> {value.detail}
                        </span>
                        <span style={{ fontWeight: 600, color: value.score > 0 ? 'var(--color-danger)' : 'var(--color-text-hint)' }}>
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

function AuditLogViewer() {
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
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
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
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
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
              <span style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', alignSelf: 'center' }}>
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

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (!user || (user.role !== 'admin' && !user.is_admin)) {
      navigate('/discover');
    }
  }, [user, navigate]);

  return (
    <div style={{ maxWidth: '960px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Admin Dashboard</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Withdrawal approvals, dispute management, KYC oversight, and platform health.
      </p>

      <nav role="tablist" style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...badgeStyle,
              cursor: 'pointer',
              background: tab === t.id ? 'var(--color-accent)' : 'var(--color-accent-soft)',
              color: tab === t.id ? 'var(--color-bg)' : 'var(--color-accent)',
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
      {tab === 'milestones' && <MilestonesQueue />}
      {tab === 'fraud' && <FraudQueue />}
      {tab === 'audit' && <AuditLogViewer />}
    </div>
  );
}
