import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';
import RelativeTime from '../RelativeTime';
import Drawer from './AdminShared';

export default function WithdrawalQueue() {
  const { t } = useTranslation();
  const [rows, setRows] = useState([]);
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [contributions, setContributions] = useState([]);
  const [events, setEvents] = useState([]);
  const [canApprove, setCanApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const openReview = useCallback((row) => {
    setReview(row);
    setError(null);
    setDetail(null);
    setContributions([]);
    setEvents([]);
    setCanApprove(false);
    // Fetch review details
    api
      .getAdminWithdrawal(row.id)
      .then((data) => {
        setDetail(data.withdrawal);
        setContributions(data.contributions || []);
        setEvents(data.events || []);
        setCanApprove(data.canApprove || false);
      })
      .catch((err) => setError(err.message || 'Failed to load review'));
  }, []);

  const closeReview = useCallback(() => {
    setReview(null);
    setDetail(null);
    setError(null);
    setContributions([]);
    setEvents([]);
  }, []);

  const approve = useCallback(async () => {
    if (!review) return;
    setBusy(true);
    try {
      await api.adminApproveWithdrawal(review.id);
      setReview(null);
      setDetail(null);
    } catch (err) {
      setError(err.message || 'Approval failed');
    } finally {
      setBusy(false);
    }
  }, [review]);

  const reject = useCallback(async () => {
    if (!review || !rejectReason.trim()) return;
    setBusy(true);
    try {
      await api.adminRejectWithdrawal(review.id, { reason: rejectReason });
      setReview(null);
      setDetail(null);
      setRejectReason('');
    } catch (err) {
      setError(err.message || 'Rejection failed');
    } finally {
      setBusy(false);
    }
  }, [review, rejectReason]);

  // Load initial data
  useEffect(() => {
    api
      .getAdminWithdrawals()
      .then((data) => setRows(data.withdrawals || []))
      .catch((err) => setError(err.message || 'Failed to load withdrawals'));
  }, []);

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
                  placeholder={t('admin.withdrawalRejectionPlaceholder')}
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
