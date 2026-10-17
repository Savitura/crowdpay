import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

const DEFAULT_COMMISSION = 5;
const DEFAULT_MAX_REFERRERS = 20;

export default function ReferralProgramSettings({ campaignId }) {
  const [program, setProgram] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [commissionPercentage, setCommissionPercentage] = useState(DEFAULT_COMMISSION);
  const [maxReferrers, setMaxReferrers] = useState(DEFAULT_MAX_REFERRERS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!campaignId) return;
    api
      .getReferralProgram(campaignId)
      .then((data) => {
        setProgram(data);
        setEnabled(true);
        setCommissionPercentage(Number(data.commission_percentage));
        setMaxReferrers(Number(data.max_referrers));
      })
      .catch(() => {
        setProgram(null);
        setEnabled(false);
      });
  }, [campaignId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const saved = await api.enableReferralProgram(campaignId, {
        commissionPercentage: Number(commissionPercentage),
        maxReferrers: Number(maxReferrers),
      });
      setProgram(saved);
      setStatus('Referral program saved.');
    } catch (err) {
      setError(err.message || 'Could not save the referral program');
    } finally {
      setSaving(false);
    }
  }, [campaignId, commissionPercentage, maxReferrers]);

  return (
    <div className="campaign-card" style={{ display: 'grid', gap: '0.85rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          aria-label="Enable referrals"
        />
        Enable Referrals
      </label>

      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
        Supporters get a trackable share link. Their commission is paid out of the campaign balance
        in the same transaction as your withdrawal.
      </p>

      {enabled && (
        <>
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            <label htmlFor="referral-commission" style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              Commission: {commissionPercentage}%
            </label>
            <input
              id="referral-commission"
              type="range"
              min="1"
              max="20"
              step="1"
              value={commissionPercentage}
              onChange={(e) => setCommissionPercentage(Number(e.target.value))}
            />
          </div>

          <div style={{ display: 'grid', gap: '0.35rem' }}>
            <label htmlFor="referral-max" style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              Maximum referrers
            </label>
            <input
              id="referral-max"
              type="number"
              min="1"
              max="100"
              value={maxReferrers}
              onChange={(e) => setMaxReferrers(e.target.value)}
              style={{ maxWidth: '8rem', padding: '0.4rem 0.5rem' }}
            />
          </div>

          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
            style={{ justifySelf: 'start' }}
          >
            {saving ? 'Saving…' : program ? 'Update referral program' : 'Enable referrals'}
          </button>
        </>
      )}

      {error && (
        <p style={{ margin: 0, color: 'var(--color-danger)', fontSize: '0.85rem' }}>{error}</p>
      )}
      {status && (
        <p style={{ margin: 0, color: 'var(--color-success)', fontSize: '0.85rem' }}>{status}</p>
      )}
    </div>
  );
}
