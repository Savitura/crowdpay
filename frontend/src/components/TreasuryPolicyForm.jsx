import React, { useState } from 'react';
import { api } from '../services/api';

/**
 * Policy configuration for a contract-mode campaign. Shown at creation time and
 * only until the treasury is deployed — after that the on-chain policy governs and
 * the backend refuses edits, so the form reports that rather than pretending to save.
 */
export default function TreasuryPolicyForm({ campaignId, initialPolicy = {}, onSaved }) {
  const [policy, setPolicy] = useState({
    minHoldDays: initialPolicy.min_hold_days ?? 0,
    maxSingleWithdrawalPct: initialPolicy.max_single_withdrawal_pct ?? 100,
    withdrawalCooldownHours: initialPolicy.withdrawal_cooldown_hours ?? 0,
    requireAuditorForAbove: initialPolicy.require_auditor_for_above ?? '0',
    autoRefundOnMiss: initialPolicy.auto_refund_on_miss ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const update = (field) => (event) => {
    const value =
      event.target.type === 'checkbox'
        ? event.target.checked
        : event.target.type === 'range' || event.target.type === 'number'
          ? Number(event.target.value)
          : event.target.value;
    setPolicy((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await api.setTreasuryPolicy(campaignId, policy);
      setSaved(true);
      if (onSaved) onSaved(result);
    } catch (err) {
      setError(
        err.code === 'TREASURY_ALREADY_DEPLOYED'
          ? 'The treasury is already deployed — its policy is fixed on-chain and cannot be edited.'
          : err.message || 'Could not save the treasury policy'
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Treasury policy">
      <p style={{ color: 'var(--color-text-muted)' }}>
        These rules are enforced by the Soroban contract that holds the funds, not by CrowdPay. Once
        the treasury is deployed they cannot be changed.
      </p>

      <label htmlFor="minHoldDays">
        Minimum hold period: <strong>{policy.minHoldDays} days</strong> after the deadline
      </label>
      <input
        id="minHoldDays"
        type="range"
        min="0"
        max="90"
        value={policy.minHoldDays}
        onChange={update('minHoldDays')}
      />

      <label htmlFor="maxSingleWithdrawalPct">
        Maximum single withdrawal: <strong>{policy.maxSingleWithdrawalPct}%</strong> of the balance
      </label>
      <input
        id="maxSingleWithdrawalPct"
        type="range"
        min="10"
        max="100"
        value={policy.maxSingleWithdrawalPct}
        onChange={update('maxSingleWithdrawalPct')}
      />

      <label htmlFor="withdrawalCooldownHours">
        Cooldown between withdrawals: <strong>{policy.withdrawalCooldownHours} hours</strong>
      </label>
      <input
        id="withdrawalCooldownHours"
        type="range"
        min="0"
        max="168"
        value={policy.withdrawalCooldownHours}
        onChange={update('withdrawalCooldownHours')}
      />

      <label htmlFor="requireAuditorForAbove">Auditor required above</label>
      <input
        id="requireAuditorForAbove"
        type="text"
        inputMode="decimal"
        value={policy.requireAuditorForAbove}
        onChange={update('requireAuditorForAbove')}
      />

      <label htmlFor="autoRefundOnMiss">
        <input
          id="autoRefundOnMiss"
          type="checkbox"
          checked={policy.autoRefundOnMiss}
          onChange={update('autoRefundOnMiss')}
        />
        Refund contributors automatically if the goal is missed
      </label>
      <small style={{ color: 'var(--color-text-muted)' }}>
        Anyone can trigger the refund once the deadline passes, so contributors are not dependent on
        you or CrowdPay acting.
      </small>

      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {saved && <p style={{ color: 'var(--color-success)' }}>Treasury policy saved.</p>}

      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save treasury policy'}
      </button>
    </form>
  );
}
