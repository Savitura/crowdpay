import React from 'react';

export default function CampaignRewardsTab({ nftRewards = [], tiers = [], formatNaira }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      {nftRewards.length > 0 && (
        <div style={{ marginBottom: '1.25rem' }}>
          <h2 style={styles.sectionTitle}>NFT proof of support</h2>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {nftRewards.slice(0, 3).map((reward) => (
              <div key={reward.id} style={{ ...styles.card, marginBottom: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <strong>{reward.reward_tier_title || 'NFT reward'}</strong>
                  <span style={styles.small}>{reward.status || 'configured'}</span>
                </div>
                {reward.serial_number && (
                  <p style={{ ...styles.small, marginTop: '0.4rem' }}>
                    Serial: {reward.serial_number}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tiers.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <h2 style={styles.sectionTitle}>Reward tiers</h2>
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {tiers.map((tier) => (
              <div
                key={tier.id}
                style={{
                  ...styles.card,
                  marginBottom: 0,
                  opacity: tier.sold_out ? 0.65 : 1,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                  }}
                >
                  <strong style={{ fontSize: '1.05rem' }}>{tier.title}</strong>
                  <span style={styles.asset}>
                    {Number(tier.min_amount).toLocaleString()}+ {tier.asset_type}
                    {formatNaira && formatNaira(tier.min_amount) && (
                      <span style={styles.nairaTier} title="Approximate NGN value">
                        {' '}
                        (≈ ₦{formatNaira(tier.min_amount)} approx.)
                      </span>
                    )}
                  </span>
                </div>
                {tier.description && (
                  <p style={{ ...styles.small, marginTop: '0.5rem', lineHeight: 1.5 }}>
                    {tier.description}
                  </p>
                )}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    marginTop: '0.75rem',
                  }}
                >
                  {tier.estimated_delivery && (
                    <span style={styles.small}>
                      Estimated delivery: {new Date(tier.estimated_delivery).toLocaleDateString()}
                    </span>
                  )}
                  <span style={{ ...styles.small, fontWeight: 700, marginLeft: 'auto' }}>
                    {tier.sold_out
                      ? 'Sold out'
                      : tier.remaining === null || tier.remaining === undefined
                        ? 'Unlimited backers'
                        : `${Number(tier.remaining).toLocaleString()} remaining`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.25rem',
    marginBottom: '1rem',
  },
  small: { fontSize: '0.85rem', color: 'var(--color-text-muted)' },
  asset: {
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    fontSize: '0.75rem',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '99px',
  },
  nairaTier: {
    fontSize: '0.85rem',
    color: 'var(--color-text-secondary)',
    fontWeight: 500,
    marginLeft: '0.25rem',
  },
};
