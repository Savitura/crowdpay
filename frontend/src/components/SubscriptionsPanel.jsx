import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

const PERIOD_LABELS = { 1: 'Monthly', 3: 'Quarterly', 6: 'Semi-annual' };

// Why a campaign stopped collecting installments (#837), keyed by closure_reason.
const CLOSURE_REASONS = {
  campaign_funded: 'the campaign reached its goal',
  campaign_failed: 'the campaign did not reach its goal',
  campaign_suspended: 'the campaign was suspended',
  campaign_deleted: 'the campaign was removed',
  campaign_closed: 'the campaign is no longer accepting contributions',
  campaign_deadline_passed: "the remaining installments fall after the campaign's deadline",
};

function ClosureNotice({ subscription }) {
  if (!subscription.periods_closed) return null;
  const reason = CLOSURE_REASONS[subscription.closure_reason] || CLOSURE_REASONS.campaign_closed;
  const reclaimable = subscription.reclaimable_from && new Date(subscription.reclaimable_from) <= new Date();
  return (
    <p className="alert alert--info" style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
      {subscription.periods_closed} remaining installment{subscription.periods_closed === 1 ? '' : 's'} (
      {subscription.closed_amount} {subscription.asset}) will not be collected because {reason}. The funds
      stay locked in their claimable balance{subscription.periods_closed === 1 ? '' : 's'} and{' '}
      {reclaimable
        ? 'can now be reclaimed to your wallet.'
        : `become reclaimable to your wallet from ${formatDate(subscription.reclaimable_from)}.`}
    </p>
  );
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function SubscriptionRow({ subscription, result, onCancelled }) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

  async function cancel() {
    setCancelling(true);
    setError('');
    try {
      const summary = await api.cancelSubscription(subscription.campaign_id, subscription.id);
      onCancelled?.(subscription.id, summary);
    } catch (err) {
      setError(err.message || 'Could not cancel this subscription');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="campaign-card" style={{ minHeight: 'auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div>
          <Link
            to={`/campaigns/${subscription.campaign_id}`}
            style={{ fontWeight: 700, color: 'var(--color-accent)' }}
          >
            {subscription.campaign_title}
          </Link>
          <div style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginTop: '0.25rem' }}>
            {subscription.amount_per_period} {subscription.asset} ·{' '}
            {PERIOD_LABELS[subscription.period_months] || `Every ${subscription.period_months} months`} ·{' '}
            {subscription.periods_claimed}/{subscription.total_periods} paid
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)', marginTop: '0.2rem' }}>
            Next payment: {formatDate(subscription.next_payment_date)}
          </div>
        </div>

        {subscription.status === 'active' ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={cancel}
            disabled={cancelling}
            aria-busy={cancelling}
            style={{ fontSize: '0.82rem', padding: '0.35rem 0.9rem' }}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          <span style={{ fontSize: '0.82rem', color: 'var(--color-text-hint)' }}>
            {subscription.status}
          </span>
        )}
      </div>

      <ClosureNotice subscription={subscription} />

      {error && (
        <p className="alert alert--error" style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
          {error}
        </p>
      )}

      {result && (
        <p className="alert alert--info" style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
          {result.cancelled} future payment{result.cancelled === 1 ? '' : 's'} cancelled
          {result.nonCancellable > 0
            ? `, ${result.nonCancellable} could not be cancelled (already claimed or due within 7 days)`
            : ''}
          .
          {result.estimatedRefundDate
            ? ` You can reclaim the locked funds from ${formatDate(result.estimatedRefundDate)}.`
            : ''}
        </p>
      )}
    </div>
  );
}

export default function SubscriptionsPanel() {
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Cancellation summaries live here so they survive the refresh that follows a cancel.
  const [cancellations, setCancellations] = useState({});

  const load = useCallback(
    () =>
      api
        .getMySubscriptions()
        .then((data) => setSubscriptions(data.subscriptions || []))
        .catch((err) => setError(err.message || 'Could not load subscriptions'))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  function handleCancelled(subscriptionId, summary) {
    setCancellations((prev) => ({ ...prev, [subscriptionId]: summary }));
    load();
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading subscriptions…</p>;
  if (error) return <p className="alert alert--error">{error}</p>;
  if (!subscriptions.length) {
    return (
      <p className="alert alert--info">
        You have no recurring pledges yet. Open a campaign and choose “Pledge Monthly” to start one.
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {subscriptions.map((subscription) => (
        <SubscriptionRow
          key={subscription.id}
          subscription={subscription}
          result={cancellations[subscription.id]}
          onCancelled={handleCancelled}
        />
      ))}
    </div>
  );
}
