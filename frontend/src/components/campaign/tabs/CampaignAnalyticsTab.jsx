import React from 'react';
import CampaignReferralsTab from '../../CampaignReferralsTab';
import TreasuryPanel from '../../TreasuryPanel';

const BackerInsightsCard = React.lazy(() => import('../../BackerInsightsCard'));

export default function CampaignAnalyticsTab({
  campaign,
  user = null,
  analytics = null,
  analyticsTab = 'overview',
  setAnalyticsTab,
  backersAnalytics = null,
  analyticsBackersLoading = false,
}) {
  if (!campaign) return null;

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={styles.sectionTitle}>Analytics</h2>

      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1rem',
          borderBottom: '1px solid var(--color-border-light)',
          paddingBottom: '0.75rem',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={analyticsTab === 'overview'}
          onClick={() => setAnalyticsTab('overview')}
          style={{
            background: analyticsTab === 'overview' ? 'var(--color-accent)' : 'transparent',
            color: analyticsTab === 'overview' ? 'var(--color-bg)' : 'var(--color-text-primary)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '6px',
            padding: '0.4rem 0.9rem',
            fontWeight: 600,
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
        >
          Overview
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={analyticsTab === 'backers'}
          onClick={() => setAnalyticsTab('backers')}
          style={{
            background: analyticsTab === 'backers' ? 'var(--color-accent)' : 'transparent',
            color: analyticsTab === 'backers' ? 'var(--color-bg)' : 'var(--color-text-primary)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '6px',
            padding: '0.4rem 0.9rem',
            fontWeight: 600,
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
        >
          Backers
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={analyticsTab === 'referrals'}
          onClick={() => setAnalyticsTab('referrals')}
          style={{
            background: analyticsTab === 'referrals' ? 'var(--color-accent)' : 'transparent',
            color: analyticsTab === 'referrals' ? 'var(--color-bg)' : 'var(--color-text-primary)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '6px',
            padding: '0.4rem 0.9rem',
            fontWeight: 600,
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
        >
          Referrals
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={analyticsTab === 'treasury'}
          onClick={() => setAnalyticsTab('treasury')}
          style={{
            background: analyticsTab === 'treasury' ? 'var(--color-accent)' : 'transparent',
            color: analyticsTab === 'treasury' ? 'var(--color-bg)' : 'var(--color-text-primary)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '6px',
            padding: '0.4rem 0.9rem',
            fontWeight: 600,
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
        >
          Treasury
        </button>
      </div>

      {analyticsTab === 'overview' && (
        <>
          {!analytics?.dailyTotals || analytics.dailyTotals.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>No analytics data available yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: '1.5rem' }}>
              <div className="campaign-card">
                <strong style={{ display: 'block', marginBottom: '1rem' }}>
                  Contributions (Last 30 Days)
                </strong>

                <svg width="100%" height={150} viewBox="0 0 600 150" preserveAspectRatio="none">
                  {analytics.dailyTotals.map((day, i) => {
                    const maxAmount = Math.max(
                      ...analytics.dailyTotals.map((d) => Number(d.total_amount) || 0),
                      1
                    );
                    const barWidth = 600 / Math.max(analytics.dailyTotals.length, 1);
                    const barHeight = Math.max(5, (Number(day.total_amount) / maxAmount) * 150);
                    const y = 150 - barHeight;
                    const x = i * barWidth;
                    return (
                      <g key={i}>
                        <title>{`${new Date(day.day).toLocaleDateString()}: ${day.total_amount} ${day.asset}`}</title>
                        <rect
                          x={x}
                          y={y}
                          width={Math.max(barWidth - 2, 2)}
                          height={barHeight}
                          fill="var(--color-accent)"
                          rx="2"
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div className="campaign-card">
                <strong style={{ display: 'block', marginBottom: '1rem' }}>Asset Breakdown</strong>
                {analytics.assetBreakdown?.map((asset) => (
                  <div
                    key={asset.paid_with}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <span>{asset.paid_with}</span>
                    <strong>{asset.total_sent}</strong>
                  </div>
                ))}
              </div>

              <div className="campaign-card">
                <strong style={{ display: 'block', marginBottom: '1rem' }}>Top Contributors</strong>
                {analytics.topContributors?.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                      fontFamily: 'monospace',
                    }}
                  >
                    <span>
                      {c.sender_public_key?.slice(0, 4)}...
                      {c.sender_public_key?.slice(-4)}
                    </span>
                    <span>
                      {c.total} ({c.times} contributions)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {analyticsTab === 'backers' && (
        <React.Suspense
          fallback={<p style={{ color: 'var(--color-text-muted)' }}>Loading backer insights...</p>}
        >
          {analyticsBackersLoading ? (
            <p style={{ color: 'var(--color-text-muted)' }}>Loading backer insights...</p>
          ) : (
            <BackerInsightsCard data={backersAnalytics} assetType={campaign.asset_type} />
          )}
        </React.Suspense>
      )}

      {analyticsTab === 'referrals' && (
        <CampaignReferralsTab campaignId={campaign.id} assetType={campaign.asset_type} />
      )}

      {analyticsTab === 'treasury' && (
        <TreasuryPanel
          campaignId={campaign.id}
          assetType={campaign.asset_type}
          isAuditor={
            Boolean(campaign.auditor_public_key) &&
            campaign.auditor_public_key === user?.wallet_public_key
          }
        />
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
};
