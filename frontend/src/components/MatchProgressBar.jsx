import React from 'react';

/**
 * MatchProgressBar — shows real-time sponsor matching progress.
 * Renders a segmented bar: contributions (blue) + matched (green).
 * Updates via polling or websocket.
 *
 * @component
 * @param {Object} props
 * @param {string} props.campaignId - Campaign UUID
 * @param {bigint|number} props.totalPledged - Total matched funds available
 * @param {bigint|number} props.totalMatched - Funds used so far
 * @param {number} props.matchRatio - Match ratio (e.g., 1.0, 2.0)
 * @returns {JSX.Element}
 */
export function MatchProgressBar({ campaignId, totalPledged, totalMatched, matchRatio }) {
  if (!totalPledged || totalPledged === 0n) {
    return null;
  }

  const pledged = typeof totalPledged === 'bigint' ? Number(totalPledged) : totalPledged;
  const matched = typeof totalMatched === 'bigint' ? Number(totalMatched) : totalMatched;

  const percentage = pledged > 0 ? (matched * 100) / pledged : 0;

  const percentageDisplay = Math.min(percentage, 100).toFixed(0);
  const matchRatioDisplay = matchRatio % 1 === 0 ? matchRatio : matchRatio.toFixed(1);

  return (
    <div style={{ marginTop: '1.25rem', marginBottom: '1.25rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '0.75rem',
          marginBottom: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--color-success-text)', fontSize: '0.95rem' }}>
          🤝 Sponsor Matching Active ({matchRatioDisplay}:1)
        </span>
        <span style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>
          {percentageDisplay}% of pool used
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={Number(percentage.toFixed(0))}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${percentageDisplay}% of sponsor matching pool used`}
        style={{
          width: '100%',
          backgroundColor: 'var(--color-bg-alt, #f0f0f0)',
          borderRadius: '6px',
          height: '12px',
          overflow: 'hidden',
          border: '1px solid var(--color-border-light)',
        }}
      >
        <div
          style={{
            height: '100%',
            backgroundColor: 'var(--color-success, #10b981)',
            width: `${Math.min(percentage, 100)}%`,
            transition: 'width 0.3s ease',
            borderRadius: '6px',
          }}
          aria-hidden="true"
        />
      </div>

      <p
        style={{
          fontSize: '0.85rem',
          color: 'var(--color-text-secondary)',
          marginTop: '0.5rem',
          marginBottom: 0,
          lineHeight: 1.4,
        }}
      >
        {formatAmount(matched)} matched of {formatAmount(pledged)} pledged by sponsor
        {matched >= pledged ? ' (pool exhausted)' : ''}
      </p>
    </div>
  );
}

/**
 * SponsorBadge — shows sponsor name and match ratio on campaign page
 *
 * @component
 * @param {Object} props
 * @param {Object[]} props.matches - Array of matching records
 * @returns {JSX.Element}
 */
export function SponsorBadgesRow({ matches }) {
  if (!matches || matches.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: '0.5rem',
        flexWrap: 'wrap',
        marginTop: '0.75rem',
      }}
    >
      {matches.map((match) => {
        const matchRatioDisplay =
          match.matchRatio % 1 === 0 ? match.matchRatio : match.matchRatio.toFixed(1);

        return (
          <span
            key={match.id}
            title={`${match.sponsorName} is matching at ${matchRatioDisplay}:1`}
            style={{
              background: 'var(--color-success-bg, #d1fae5)',
              color: 'var(--color-success-text, #065f46)',
              borderRadius: '999px',
              fontSize: '0.75rem',
              fontWeight: 600,
              padding: '0.35rem 0.7rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              whiteSpace: 'nowrap',
            }}
          >
            <span aria-hidden="true">🤝</span>
            <span>{match.sponsorName || `Sponsor (${matchRatioDisplay}:1)`}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Helper function to format amounts with thousands separator
 * @param {number} amount
 * @returns {string}
 */
function formatAmount(amount) {
  if (amount === null || amount === undefined) return '0';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return '0';
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 7,
  });
}

export default MatchProgressBar;
