import React, { useState, useEffect } from 'react';
import { api } from '../../services/api';

/**
 * CampaignRequirementsNotice - shown to non-logged-in visitors when the
 * campaign has KYC or reputation requirements set.
 */
export function CampaignRequirementsNotice({ campaignId }) {
  const [req, setReq] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getCampaignRequirements(campaignId)
      .then((data) => {
        if (!cancelled) setReq(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (!req) return null;
  const attestations = req.required_attestations || [];
  const hasRequirements = req.min_reputation_score > 0 || attestations.length > 0;
  if (!hasRequirements) return null;

  const lines = [];
  if (attestations.length) {
    const label = attestations[attestations.length - 1].replace('kyc_', 'KYC ');
    lines.push(
      `This campaign requires ${label.charAt(0).toUpperCase() + label.slice(1)} verification`
    );
  }
  if (req.min_reputation_score > 0) {
    lines.push(`Minimum reputation score: ${req.min_reputation_score}`);
  }

  return (
    <div
      style={{
        padding: '0.5rem 0.75rem',
        borderRadius: '0.4rem',
        background: '#fffbeb',
        border: '1px solid #fde68a',
        fontSize: '0.8rem',
        color: '#92400e',
      }}
    >
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

/**
 * Shows an eligible or requirements not met badge.
 * Fetches campaign requirements and contributor profile in parallel.
 */
export function ContributorEligibilityBadge({ user, campaignId }) {
  const [status, setStatus] = useState(null);
  const [missing, setMissing] = useState([]);

  useEffect(() => {
    if (!user?.wallet_public_key || !campaignId) return;
    let cancelled = false;
    setStatus('loading');

    Promise.all([
      api.getCampaignRequirements(campaignId),
      api.getContributorIdentityProfile(user.wallet_public_key),
    ])
      .then(([req, profile]) => {
        if (cancelled) return;

        const noReq =
          (!req.min_reputation_score || req.min_reputation_score === 0) &&
          (!req.required_attestations || req.required_attestations.length === 0);

        if (noReq) {
          setStatus('no-requirements');
          return;
        }

        const gaps = [];

        if (req.min_reputation_score > 0 && profile.reputationScore < req.min_reputation_score) {
          gaps.push(
            `Reputation score ${profile.reputationScore} / ${req.min_reputation_score} required`
          );
        }

        for (const attType of req.required_attestations || []) {
          const hasAtt = profile.attestations.some(
            (a) =>
              a.type === attType &&
              !a.revoked &&
              (!a.expiresAt || new Date(a.expiresAt) > new Date())
          );
          if (!hasAtt) {
            const label = attType.replace('kyc_', 'KYC ');
            gaps.push(`Missing ${label.charAt(0).toUpperCase() + label.slice(1)} verification`);
          }
        }

        setMissing(gaps);
        setStatus(gaps.length ? 'ineligible' : 'eligible');
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.wallet_public_key, campaignId]);

  if (!status || status === 'loading' || status === 'no-requirements') return null;

  if (status === 'eligible') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.45rem 0.75rem',
          borderRadius: '0.4rem',
          background: '#f0fff4',
          border: '1px solid #9ae6b4',
          fontSize: '0.82rem',
          color: '#276749',
          marginBottom: '0.5rem',
        }}
        role="status"
        aria-label="You are eligible to contribute"
      >
        <span aria-hidden="true">[Eligible]</span>
        <span>You are eligible to contribute</span>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '0.55rem 0.75rem',
        borderRadius: '0.4rem',
        background: '#fff5f5',
        border: '1px solid #fed7d7',
        fontSize: '0.82rem',
        color: '#c53030',
        marginBottom: '0.5rem',
      }}
      role="alert"
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        <span aria-hidden="true">[Locked]</span> Requirements not met
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {missing.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
