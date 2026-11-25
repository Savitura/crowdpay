import { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import RelativeTime from '../RelativeTime';
import DisputeResolveModal from '../DisputeResolveModal';
import Drawer, { badgeStyle, cardStyle } from './AdminShared';

export default function DisputeManagement() {
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
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
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
                    <div
                      key={ev.id}
                      style={{
                        borderBottom: '1px solid var(--color-border-light)',
                        paddingBottom: '0.5rem',
                      }}
                    >
                      <div
                        style={{ fontWeight: 600, fontSize: '0.8rem', textTransform: 'capitalize' }}
                      >
                        {ev.submitted_by_name || 'Unknown'} ({ev.role})
                      </div>
                      <div>{ev.text}</div>
                      {(ev.attachment_urls || []).map((url) => (
                        <div key={url}>
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ wordBreak: 'break-all' }}
                          >
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
