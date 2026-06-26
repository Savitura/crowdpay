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
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

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
    setNote('');
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
    setNote('');
  }

  async function resolve(status) {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await api.updateDispute(selected.id, {
        status,
        resolution_note: note.trim() || undefined,
      });
      setDisputes((prev) =>
        prev
          .map((d) => (d.id === updated.id ? { ...d, ...updated } : d))
          .filter((d) => ['open', 'under_review'].includes(d.status))
      );
      closeDispute();
    } catch (err) {
      alert(err.message || 'Could not update dispute');
    } finally {
      setBusy(false);
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

            <label className="label-strong" htmlFor="dispute-note">
              Resolution note
            </label>
            <textarea
              id="dispute-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => resolve('resolved_contributor')}
                style={{ fontSize: '0.8rem' }}
              >
                Resolve for contributor (refund)
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => resolve('resolved_creator')}
                style={{ fontSize: '0.8rem' }}
              >
                Resolve for creator
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => resolve('under_review')}
                style={{ fontSize: '0.8rem' }}
              >
                Escalate (under review)
              </button>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}

function KycOversight() {
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

function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
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
                {c.status} · #{c.id.slice(0, 8)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
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
