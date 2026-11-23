import React from 'react';
import { Link } from 'react-router-dom';
import MilestoneFunnel from './MilestoneFunnel';
import { exportCSV } from '../../lib/dashboardHelpers';

const MiniLineChart = React.lazy(() => import('../MiniLineChart'));
const BackerInsightsCard = React.lazy(() => import('../BackerInsightsCard'));

import { useTranslation } from 'react-i18next';
export default function PerCampaignAnalytics({
  campaigns,
  selectedCampaignId,
  campaignAnalytics,
  campaignContributors,
  campaignBackers,
  campaignContributions,
  analyticsLoading,
  contributionsLoading,
  onSelectCampaign,
  onThankYou,
}) {
  const { t } = useTranslation();

  return (
    <>
      {/* Per-campaign drill-down */}
      <div className="campaign-card" style={{ minHeight: 'auto' }}>
        <strong style={{ display: 'block', marginBottom: '0.6rem' }}>
          {t('dashboard.perCampaignAnalytics')}
        </strong>
        {campaigns.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
            {t('dashboard.noCampaigns')}
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginBottom: '0.75rem',
            }}
          >
            {campaigns.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelectCampaign(c.id)}
                  style={{
                    padding: '0.3rem 0.75rem',
                    borderRadius: 8,
                    border: '1px solid var(--color-border)',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    background: selectedCampaignId === c.id ? 'var(--color-accent)' : 'transparent',
                    color: selectedCampaignId === c.id ? '#fff' : 'var(--color-text-secondary)',
                  }}
                >
                  {c.title}
                </button>
                <Link
                  to={`/dashboard/analytics/${c.id}`}
                  style={{
                    color: 'var(--color-accent)',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Deep Dive →
                </Link>
              </div>
            ))}
          </div>
        )}

        {analyticsLoading && (
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
            {t('common.loading')}
          </p>
        )}

        {campaignAnalytics && !analyticsLoading && (
          <>
            {/* Summary row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
                gap: '0.5rem',
                marginBottom: '0.75rem',
              }}
            >
              {[
                [
                  t('dashboard.analyticsOverview.totalRaised'),
                  `${Number(campaignAnalytics.campaign.raised_amount).toLocaleString()} ${campaignAnalytics.campaign.asset_type}`,
                ],
                [
                  t('dashboard.analyticsOverview.contributions'),
                  campaignAnalytics.summary.total_contributions,
                ],
                [
                  t('dashboard.analyticsOverview.uniqueContributors'),
                  campaignAnalytics.summary.unique_contributors,
                ],
                [
                  t('dashboard.analyticsOverview.avgContribution'),
                  Number(campaignAnalytics.summary.avg_contribution).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  }),
                ],
              ].map(([label, val]) => (
                <div
                  key={label}
                  className="campaign-card"
                  style={{ minHeight: 'auto', padding: '0.6rem 0.75rem' }}
                >
                  <strong style={{ fontSize: '1rem' }}>{val}</strong>
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>
                    {label}
                  </div>
                </div>
              ))}
            </div>

            {/* Contributor stats card */}
            {campaignContributors && (
              <div
                className="campaign-card"
                style={{ minHeight: 'auto', marginBottom: '0.75rem', padding: '0.75rem' }}
              >
                <strong style={{ fontSize: '0.9rem' }}>{t('dashboard.contributorStats')}</strong>
                <div
                  style={{
                    marginTop: '0.4rem',
                    display: 'flex',
                    gap: '1.5rem',
                    flexWrap: 'wrap',
                    fontSize: '0.88rem',
                  }}
                >
                  <span>
                    {t('dashboard.firstTime')}:{' '}
                    <strong>{campaignContributors.first_time_contributors ?? 0}</strong>
                  </span>
                  <span>
                    {t('dashboard.returning')}:{' '}
                    <strong>{campaignContributors.repeat_contributors ?? 0}</strong>
                  </span>
                  {campaignContributors.repeat_contributors > 0 && (
                    <span>
                      {t('dashboard.returnRate')}:{' '}
                      <strong>
                        {(
                          (campaignContributors.repeat_contributors /
                            ((campaignContributors.repeat_contributors || 0) +
                              (campaignContributors.first_time_contributors || 0))) *
                          100
                        ).toFixed(0)}
                        %
                      </strong>
                    </span>
                  )}
                </div>
                {campaignContributors.country_breakdown?.length > 0 && (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--color-text-hint)' }}>
                      {t('dashboard.topCountry')}:{' '}
                    </span>
                    <strong>{campaignContributors.country_breakdown[0].country}</strong>
                    <span style={{ color: 'var(--color-text-hint)' }}>
                      {' '}
                      (
                      {campaignContributors.country_breakdown
                        .map((c) => `${c.country} ${c.contributor_count}`)
                        .slice(0, 3)
                        .join(' · ')}
                      )
                    </span>
                  </div>
                )}
              </div>
            )}

            {campaignBackers && (
              <React.Suspense
                fallback={
                  <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
                    Loading chart…
                  </p>
                }
              >
                <BackerInsightsCard
                  data={campaignBackers}
                  assetType={campaignAnalytics?.campaign?.asset_type || 'XLM'}
                />
              </React.Suspense>
            )}

            {/* Time-series chart */}
            <strong style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>
              {t('dashboard.contributionsOverTime')}
            </strong>
            <React.Suspense
              fallback={
                <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
                  Loading chart…
                </p>
              }
            >
              <MiniLineChart
                data={campaignAnalytics.daily_buckets}
                dataKey="total_amount"
                label={t('dashboard.amount')}
              />
            </React.Suspense>

            {/* Milestone funnel */}
            <MilestoneFunnel campaignId={selectedCampaignId} />

            {/* CSV export */}
            {campaignAnalytics.daily_buckets?.length > 0 && (
              <button
                type="button"
                className="btn-primary"
                style={{ marginTop: '0.75rem', fontSize: '0.82rem', padding: '0.3rem 0.8rem' }}
                onClick={() =>
                  exportCSV(
                    campaignAnalytics.daily_buckets.map((r) => ({
                      date: r.day,
                      contributions: r.contribution_count,
                      amount: r.total_amount,
                    })),
                    `campaign_${selectedCampaignId}_analytics.csv`
                  )
                }
              >
                {t('dashboard.exportCsv')}
              </button>
            )}

            {/* Contributions list with individual thank-you */}
            {campaignContributions.length > 0 && !contributionsLoading && (
              <div className="campaign-card" style={{ minHeight: 'auto', marginTop: '0.75rem' }}>
                <strong style={{ display: 'block', marginBottom: '0.6rem', fontSize: '0.9rem' }}>
                  {t('dashboard.contributors')}
                </strong>
                <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                  {campaignContributions.map((ct) => (
                    <div
                      key={ct.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.4rem 0',
                        borderBottom: '1px solid var(--color-border-lighter)',
                        fontSize: '0.85rem',
                      }}
                    >
                      <span>
                        {ct.display_name || ct.sender_public_key?.slice(0, 8) + '…'}{' '}
                        <span style={{ color: 'var(--color-text-hint)' }}>
                          · {Number(ct.amount).toLocaleString()} {ct.asset} ·{' '}
                          {new Date(ct.created_at).toLocaleDateString()}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() =>
                          onThankYou({
                            id: ct.id,
                            display_name: ct.display_name || 'contributor',
                          })
                        }
                        style={{ fontSize: '0.78rem', padding: '0.2rem 0.6rem' }}
                      >
                        {t('dashboard.sendThankYou')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
