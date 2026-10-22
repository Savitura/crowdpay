import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import {
  validateMonetaryInput,
  parseDecimal,
  isValidDecimal,
  compareDecimals,
} from '../utils/decimal';

function Amount({ value, asset }) {
  if (value === undefined || value === null) return <span>—</span>;
  return (
    <span>
      {Number(value).toLocaleString(undefined, { maximumFractionDigits: 7 })} {asset}
    </span>
  );
}

/**
 * Public transparency panel. Every figure here comes from the contract read, not
 * from the campaign row, so what contributors see is what the contract enforces.
 */
export function TreasuryTransparencyPanel({ campaignId, assetType = 'USDC', explorerBase }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!campaignId) return;
    api
      .getTreasuryStatus(campaignId)
      .then(setStatus)
      .catch((err) => setError(err.code === 'NOT_CONTRACT_WALLET' ? 'not_contract' : err.message));
  }, [campaignId]);

  if (error === 'not_contract') return null;
  if (error) return <p style={{ color: 'var(--color-danger)' }}>{error}</p>;
  if (!status) return <p style={{ color: 'var(--color-text-muted)' }}>Loading treasury…</p>;

  const explorer = `${explorerBase || 'https://stellar.expert/explorer/testnet/contract'}/${status.contractId}`;

  return (
    <section aria-label="Treasury transparency">
      <h3>🔒 Funds secured by a Soroban contract</h3>
      <p>
        <a href={explorer} target="_blank" rel="noopener noreferrer">
          View the contract on Stellar Expert
        </a>
      </p>

      {status.paused && (
        <p style={{ color: 'var(--color-warning)' }}>
          This treasury is currently paused — no funds can move in or out.
        </p>
      )}

      <dl>
        <dt>Total received</dt>
        <dd>
          <Amount value={status.totalReceived} asset={assetType} />
        </dd>
        <dt>Total withdrawn</dt>
        <dd>
          <Amount value={status.totalWithdrawn} asset={assetType} />
        </dd>
        <dt>Hold period</dt>
        <dd>
          {status.policy.minHoldDays === 0
            ? 'No hold period'
            : `${status.policy.minHoldDays} days after the deadline`}
        </dd>
        <dt>Maximum single withdrawal</dt>
        <dd>{status.policy.maxSingleWithdrawalPct}% of the balance</dd>
        <dt>Automatic refund if the goal is missed</dt>
        <dd>{status.policy.autoRefundOnMiss ? 'Yes' : 'No'}</dd>
      </dl>
    </section>
  );
}

/**
 * Creator-facing treasury tab: balances, the policy as the contract holds it, a
 * withdrawal form that reports which constraint applies, and the on-chain history.
 */
export default function TreasuryPanel({ campaignId, assetType = 'USDC', isAuditor = false }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const load = useCallback(() => {
    if (!campaignId) return;
    api
      .getTreasuryStatus(campaignId)
      .then((next) => {
        setStatus(next);
        setError('');
      })
      .catch((err) => setError(err.code === 'NOT_CONTRACT_WALLET' ? 'not_contract' : err.message));
  }, [campaignId]);

  useEffect(load, [load]);

  async function submitWithdrawal(event) {
    event.preventDefault();
    const amountCheck = validateMonetaryInput(amount, {
      fieldName: 'Amount',
      allowZero: false,
    });
    if (!amountCheck.isValid) {
      setOutcome({ kind: 'error', message: amountCheck.error });
      return;
    }
    setSubmitting(true);
    setOutcome(null);
    try {
      const result = await api.requestTreasuryWithdrawal(campaignId, {
        amount: parseDecimal(amount),
        destination,
      });
      setOutcome(
        result.type === 'pending_auditor'
          ? { kind: 'pending', message: 'Sent to the auditor for approval.' }
          : { kind: 'done', message: 'Withdrawal executed.' }
      );
      setAmount('');
      load();
    } catch (err) {
      setOutcome({ kind: 'error', message: describeRejection(err) });
    } finally {
      setSubmitting(false);
    }
  }

  async function approve(pendingId) {
    try {
      await api.approveTreasuryWithdrawal(campaignId, pendingId);
      load();
    } catch (err) {
      setOutcome({ kind: 'error', message: describeRejection(err) });
    }
  }

  if (error === 'not_contract') {
    return (
      <p style={{ color: 'var(--color-text-muted)' }}>
        This campaign uses the standard multisig wallet, so there is no contract treasury.
      </p>
    );
  }
  if (error) return <p style={{ color: 'var(--color-danger)' }}>{error}</p>;
  if (!status) return <p style={{ color: 'var(--color-text-muted)' }}>Loading treasury…</p>;

  return (
    <section aria-label="Treasury">
      <div>
        <h3>Balance</h3>
        <p>
          Received: <Amount value={status.totalReceived} asset={assetType} />
        </p>
        <p>
          Withdrawn: <Amount value={status.totalWithdrawn} asset={assetType} />
        </p>
        <p>
          Available: <Amount value={status.available} asset={assetType} />
        </p>
      </div>

      <div>
        <h3>Policy</h3>
        <ul>
          <li>Hold period: {status.policy.minHoldDays} days after the deadline</li>
          <li>Max single withdrawal: {status.policy.maxSingleWithdrawalPct}% of the balance</li>
          <li>Cooldown: {status.policy.withdrawalCooldownHours} hours between withdrawals</li>
          <li>
            Auditor required above:{' '}
            <Amount value={status.policy.requireAuditorForAbove} asset={assetType} />
          </li>
          <li>Auto-refund on miss: {status.policy.autoRefundOnMiss ? 'on' : 'off'}</li>
        </ul>
      </div>

      <form onSubmit={submitWithdrawal} aria-label="Request withdrawal">
        <h3>Request a withdrawal</h3>
        <label htmlFor="treasury-amount">Amount</label>
        <input
          id="treasury-amount"
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
        <label htmlFor="treasury-destination">Destination</label>
        <input
          id="treasury-destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
        {amount &&
          isValidDecimal(amount, { allowZero: false }) &&
          status?.policy?.requireAuditorForAbove !== undefined &&
          isValidDecimal(status.policy.requireAuditorForAbove, { allowZero: true }) &&
          compareDecimals(amount, status.policy.requireAuditorForAbove) > 0 && (
            <p style={{ color: 'var(--color-text-muted)' }}>
              This amount is above the auditor threshold, so it will need auditor approval.
            </p>
          )}
        <button type="submit" disabled={submitting || !amount || !destination}>
          {submitting ? 'Requesting…' : 'Request withdrawal'}
        </button>
        {outcome && (
          <p
            style={{
              color: outcome.kind === 'error' ? 'var(--color-danger)' : 'var(--color-success)',
            }}
          >
            {outcome.message}
          </p>
        )}
      </form>

      {status.pendingWithdrawals.length > 0 && (
        <div>
          <h3>Awaiting auditor approval</h3>
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Destination</th>
                <th>Requested</th>
                {isAuditor && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {status.pendingWithdrawals.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Amount value={entry.amount} asset={assetType} />
                  </td>
                  <td>{entry.destination}</td>
                  <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
                  {isAuditor && (
                    <td>
                      <button type="button" onClick={() => approve(entry.id)}>
                        Approve
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h3>Withdrawal history</h3>
        {status.withdrawalHistory.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)' }}>No withdrawals yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Destination</th>
                <th>Date</th>
                <th>Approved by</th>
              </tr>
            </thead>
            <tbody>
              {status.withdrawalHistory.map((record) => (
                <tr key={record.id}>
                  <td>
                    <Amount value={record.amount} asset={assetType} />
                  </td>
                  <td>{record.destination}</td>
                  <td>{new Date(record.executedAt).toLocaleDateString()}</td>
                  <td>{record.approvedBy ? 'Auditor' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** Turns a contract rejection into something a creator can act on. */
export function describeRejection(err) {
  switch (err.code) {
    case 'HOLD_PERIOD_NOT_ELAPSED':
      return 'The hold period after the campaign deadline has not elapsed yet.';
    case 'EXCEEDS_MAX_WITHDRAWAL_PCT':
      return 'That is a larger share of the balance than the policy allows in one withdrawal.';
    case 'COOLDOWN_NOT_ELAPSED':
      return 'The cooldown since your last withdrawal has not elapsed yet.';
    case 'INSUFFICIENT_BALANCE':
      return 'The treasury does not hold that much.';
    case 'TREASURY_PAUSED':
      return 'The treasury is paused, so no funds can move.';
    case 'AUDITOR_NOT_CONFIGURED':
      return 'This amount needs an auditor, but none is configured for the campaign.';
    default:
      return err.message || 'The treasury rejected that request.';
  }
}
