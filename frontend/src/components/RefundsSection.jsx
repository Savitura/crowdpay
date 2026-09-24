import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';
import { stellarExpertTxUrl } from '../config/stellar';

export default function RefundsSection({ campaign, user, onRefundSuccess }) {
  const toast = useToast();
  const [eligibleContributions, setEligibleContributions] = useState([]);
  const [refundHistory, setRefundHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Modal state
  const [selectedContribution, setSelectedContribution] = useState(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [isForceRefund, setIsForceRefund] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = user?.role === 'admin';
  const isOwner = user?.id && campaign?.creator_id && String(campaign.creator_id) === String(user.id);

  const fetchData = useCallback(async () => {
    if (!campaign?.id) return;
    setLoading(true);
    setError('');
    try {
      const [eligibleRes, historyRes] = await Promise.all([
        api.getEligibleRefunds(campaign.id).catch(() => ({ items: [] })),
        api.getCampaignRefunds(campaign.id).catch(() => ({ items: [] })),
      ]);
      setEligibleContributions(eligibleRes.items || []);
      setRefundHistory(historyRes.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load refund data');
    } finally {
      setLoading(false);
    }
  }, [campaign?.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleOpenRefundModal = (contribution) => {
    setSelectedContribution(contribution);
    const maxRefundable = parseFloat(contribution.remaining_amount ?? (parseFloat(contribution.amount) - parseFloat(contribution.refunded_amount || 0)));
    setRefundAmount(String(maxRefundable));
    setRefundReason('');
    setIsForceRefund(false);
    setAdminNote('');
    setConfirmed(false);
  };

  const handleCloseModal = () => {
    setSelectedContribution(null);
    setRefundAmount('');
    setRefundReason('');
    setIsForceRefund(false);
    setAdminNote('');
    setConfirmed(false);
  };

  const handleRefundSubmit = async (e) => {
    e.preventDefault();
    if (!selectedContribution || submitting) return;

    const amountNum = parseFloat(refundAmount);
    const maxRefundable = parseFloat(selectedContribution.remaining_amount ?? (parseFloat(selectedContribution.amount) - parseFloat(selectedContribution.refunded_amount || 0)));

    if (isNaN(amountNum) || amountNum <= 0) {
      toast?.show?.('Please enter a valid refund amount greater than 0', 'error');
      return;
    }

    if (amountNum > maxRefundable) {
      toast?.show?.(`Refund amount cannot exceed remaining balance (${maxRefundable} ${campaign.asset_type || selectedContribution.asset || 'XLM'})`, 'error');
      return;
    }

    if (!confirmed) {
      toast?.show?.('Please confirm the refund details before submitting', 'error');
      return;
    }

    setSubmitting(true);
    try {
      await api.processRefund(campaign.id, {
        contributionId: selectedContribution.id,
        amount: amountNum,
        reason: refundReason,
        isForceRefund: isAdmin && isForceRefund,
        adminNote: isAdmin && isForceRefund ? adminNote : null,
      });

      toast?.show?.('Refund processed successfully on-chain', 'success');
      handleCloseModal();
      await fetchData();
      if (onRefundSuccess) onRefundSuccess();
    } catch (err) {
      toast?.show?.(err.response?.data?.error || err.message || 'Failed to process refund', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOwner && !isAdmin) {
    return null;
  }

  return (
    <section className="refunds-section card" data-testid="refunds-section" style={{ marginTop: '2rem', padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Refund Management</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
            Process on-chain partial or full escrow refunds to campaign contributors.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={fetchData}
          disabled={loading}
          style={{ cursor: 'pointer' }}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem', padding: '0.75rem', borderRadius: '4px' }}>
          {error}
        </div>
      )}

      {/* Eligible Contributions */}
      <div style={{ marginBottom: '2rem' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Contributions Eligible for Refund</h3>
        {loading ? (
          <p style={{ color: 'var(--color-text-secondary)' }}>Loading eligible contributions...</p>
        ) : eligibleContributions.length === 0 ? (
          <p style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
            No contributions currently eligible for refund.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                  <th style={{ padding: '0.5rem' }}>Contributor</th>
                  <th style={{ padding: '0.5rem' }}>Original Amount</th>
                  <th style={{ padding: '0.5rem' }}>Refunded</th>
                  <th style={{ padding: '0.5rem' }}>Remaining</th>
                  <th style={{ padding: '0.5rem' }}>Status</th>
                  <th style={{ padding: '0.5rem', textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {eligibleContributions.map((contrib) => {
                  const remaining = parseFloat(contrib.remaining_amount ?? (parseFloat(contrib.amount) - parseFloat(contrib.refunded_amount || 0)));
                  return (
                    <tr key={contrib.id} data-testid={`eligible-row-${contrib.id}`} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '0.5rem' }}>
                        <div style={{ fontWeight: 'bold' }}>
                          {contrib.contributor_name || contrib.contributor?.display_name || contrib.contributor?.name || contrib.display_name || 'Anonymous'}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>
                          {(contrib.contributor_wallet || contrib.sender_public_key || '').slice(0, 6)}...{(contrib.contributor_wallet || contrib.sender_public_key || '').slice(-6)}
                        </div>
                      </td>
                      <td style={{ padding: '0.5rem' }}>{contrib.amount} {contrib.asset || campaign.asset_type || 'XLM'}</td>
                      <td style={{ padding: '0.5rem', color: parseFloat(contrib.refunded_amount) > 0 ? 'var(--color-status-warning)' : 'inherit' }}>
                        {contrib.refunded_amount || 0} {contrib.asset || campaign.asset_type || 'XLM'}
                      </td>
                      <td style={{ padding: '0.5rem', fontWeight: 'bold' }}>
                        {remaining} {contrib.asset || campaign.asset_type || 'XLM'}
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        <span className={`badge ${contrib.refund_status === 'partial' ? 'badge-warning' : 'badge-info'}`}>
                          {contrib.refund_status || contrib.status}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          data-testid={`refund-btn-${contrib.id}`}
                          onClick={() => handleOpenRefundModal(contrib)}
                        >
                          Issue Refund
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Refund History */}
      <div>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Refund History</h3>
        {refundHistory.length === 0 ? (
          <p style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
            No refund records for this campaign yet.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                  <th style={{ padding: '0.5rem' }}>Date</th>
                  <th style={{ padding: '0.5rem' }}>Amount</th>
                  <th style={{ padding: '0.5rem' }}>Recipient</th>
                  <th style={{ padding: '0.5rem' }}>Status</th>
                  <th style={{ padding: '0.5rem' }}>Reason / Notes</th>
                  <th style={{ padding: '0.5rem' }}>Tx</th>
                </tr>
              </thead>
              <tbody>
                {refundHistory.map((item) => (
                  <tr key={item.id} data-testid={`history-row-${item.id}`} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                      {item.created_at ? new Date(item.created_at).toLocaleDateString() : 'N/A'}
                    </td>
                    <td style={{ padding: '0.5rem', fontWeight: 'bold' }}>
                      {item.amount} {item.asset || 'XLM'}
                      {item.is_force_refund && (
                        <span className="badge badge-danger" style={{ marginLeft: '0.5rem', fontSize: '0.7rem' }}>
                          Force
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                      {(item.recipient_wallet || '').slice(0, 6)}...{(item.recipient_wallet || '').slice(-6)}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      <span className={`badge ${item.status === 'completed' ? 'badge-success' : item.status === 'failed' ? 'badge-danger' : 'badge-warning'}`}>
                        {item.status}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                      {item.reason || <span style={{ color: 'var(--color-text-secondary)' }}>-</span>}
                      {item.admin_note && (
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                          Admin: {item.admin_note}
                        </div>
                      )}
                      {item.failure_reason && (
                        <div style={{ color: 'var(--color-status-error)', fontSize: '0.75rem' }}>
                          Error: {item.failure_reason}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                      {item.tx_hash ? (
                        <a
                          href={stellarExpertTxUrl(item.tx_hash)}
                          target="_blank"
                          rel="noreferrer noopener"
                          style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}
                        >
                          View Tx
                        </a>
                      ) : (
                        <span style={{ color: 'var(--color-text-secondary)' }}>-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {selectedContribution && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="refund-modal"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
        >
          <div
            className="card"
            style={{
              background: 'var(--color-bg-primary, #fff)',
              padding: '2rem',
              borderRadius: '8px',
              maxWidth: '520px',
              width: '90%',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Process Contributor Refund</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
              Submitting this will initiate an on-chain escrow return transaction to refund the contributor&apos;s wallet directly.
            </p>

            <div style={{ background: 'var(--color-bg-secondary, #f3f4f6)', padding: '1rem', borderRadius: '6px', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>Contributor:</span>
                <strong>{selectedContribution.contributor_name || selectedContribution.contributor?.display_name || selectedContribution.contributor?.name || selectedContribution.display_name || 'Anonymous'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>Recipient Wallet:</span>
                <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  {selectedContribution.contributor_wallet || selectedContribution.sender_public_key}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>Original Contribution:</span>
                <span>{selectedContribution.amount} {selectedContribution.asset || campaign.asset_type || 'XLM'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>Max Refundable:</span>
                <strong style={{ color: 'var(--color-primary)' }}>
                  {selectedContribution.remaining_amount ?? (parseFloat(selectedContribution.amount) - parseFloat(selectedContribution.refunded_amount || 0))} {selectedContribution.asset || campaign.asset_type || 'XLM'}
                </strong>
              </div>
            </div>

            <form onSubmit={handleRefundSubmit}>
              <div style={{ marginBottom: '1rem' }}>
                <label htmlFor="refund-amount-input" style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                  Refund Amount ({selectedContribution.asset || campaign.asset_type || 'XLM'}):
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    id="refund-amount-input"
                    type="number"
                    step="any"
                    min="0.0000001"
                    max={selectedContribution.remaining_amount ?? (parseFloat(selectedContribution.amount) - parseFloat(selectedContribution.refunded_amount || 0))}
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    required
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--color-border)' }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      const max = selectedContribution.remaining_amount ?? (parseFloat(selectedContribution.amount) - parseFloat(selectedContribution.refunded_amount || 0));
                      setRefundAmount(String(max));
                    }}
                  >
                    Full Amount
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label htmlFor="refund-reason-input" style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                  Reason for Refund (visible to contributor):
                </label>
                <textarea
                  id="refund-reason-input"
                  rows="3"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="e.g. Campaign cancelled, milestone modified, contributor goodwill..."
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--color-border)', boxSizing: 'border-box' }}
                />
              </div>

              {isAdmin && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px dashed var(--color-border)', borderRadius: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontWeight: 'bold' }}>
                    <input
                      type="checkbox"
                      checked={isForceRefund}
                      onChange={(e) => setIsForceRefund(e.target.checked)}
                      data-testid="admin-force-checkbox"
                    />
                    Admin Force-Refund (Bypass creator authorization)
                  </label>
                  {isForceRefund && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <label htmlFor="admin-note-input" style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                        Internal Admin Audit Note:
                      </label>
                      <input
                        id="admin-note-input"
                        type="text"
                        value={adminNote}
                        onChange={(e) => setAdminNote(e.target.value)}
                        placeholder="Internal reason for force refund..."
                        style={{ width: '100%', padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--color-border)', boxSizing: 'border-box' }}
                      />
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    data-testid="confirm-checkbox"
                  />
                  I confirm that this refund will permanently return funds on-chain and adjust the campaign balance.
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCloseModal}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={submitting || !confirmed}
                  data-testid="submit-refund-btn"
                >
                  {submitting ? 'Submitting On-Chain...' : 'Confirm & Process Refund'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
