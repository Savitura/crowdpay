import React from 'react';
import { Link } from 'react-router-dom';

const MiniLineChart = React.lazy(() => import('../MiniLineChart'));

import { useTranslation } from 'react-i18next';
export default function AnalyticsOverview({ dashAnalytics, onExport }) {
  const { t } = useTranslation();

  return (
    <>
      <div style={{ marginBottom: '1rem' }}>
        <Link
          to="/dashboard/analytics"
          style={{ color: 'var(--color-accent)', fontWeight: 600, fontSize: '0.9rem' }}
        >
          Open Full Analytics Dashboard →
        </Link>
      </div>
      {/* Dashboard-wide trend */}
      <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
            marginBottom: '0.75rem',
          }}
        >
          <strong>{t('dashboard.contributionsLast30Days')}</strong>
          {dashAnalytics?.recent_trend?.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              style={{ fontSize: '0.82rem', padding: '0.3rem 0.8rem' }}
              onClick={() => onExport(dashAnalytics.recent_trend, 'contributions_trend.csv')}
            >
              {t('dashboard.exportCsv')}
            </button>
          )}
        </div>
        <React.Suspense
          fallback={
            <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>Loading chart…</p>
          }
        >
          <MiniLineChart
            data={dashAnalytics?.recent_trend}
            dataKey="total_amount"
            label={t('dashboard.amount')}
          />
        </React.Suspense>
        {dashAnalytics?.overview && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
              gap: '0.5rem',
              marginTop: '0.75rem',
            }}
          >
            {[
              [
                t('dashboard.analyticsOverview.totalRaised'),
                Number(dashAnalytics.overview.total_raised).toLocaleString(),
              ],
              [
                t('dashboard.analyticsOverview.contributions'),
                dashAnalytics.overview.total_contributions,
              ],
              [
                t('dashboard.analyticsOverview.uniqueContributors'),
                dashAnalytics.overview.unique_contributors,
              ],
              [
                t('dashboard.analyticsOverview.avgContribution'),
                Number(dashAnalytics.overview.avg_contribution).toLocaleString(undefined, {
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
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Funding velocity curves — daily raised per campaign (#593) */}
      {dashAnalytics?.funding_velocity?.length > 0 && (
        <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
          <strong style={{ display: 'block', marginBottom: '0.6rem' }}>
            Funding Velocity (last 60 days)
          </strong>
          <React.Suspense
            fallback={
              <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>Loading chart…</p>
            }
          >
            <MiniLineChart
              data={dashAnalytics.funding_velocity}
              dataKey="daily_amount"
              label="Amount"
            />
          </React.Suspense>
        </div>
      )}

      {/* Contributor retention — new vs returning by month (#593) */}
      {dashAnalytics?.contributor_retention?.length > 0 && (
        <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
          <strong style={{ display: 'block', marginBottom: '0.6rem' }}>
            Contributor Retention (last 6 months)
          </strong>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.3rem 0.5rem' }}>Month</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>New</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Returning</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Retention %</th>
                </tr>
              </thead>
              <tbody>
                {dashAnalytics.contributor_retention.map((r) => {
                  const total = (r.new_count || 0) + (r.returning_count || 0);
                  const pct = total > 0 ? Math.round((r.returning_count / total) * 100) : 0;
                  return (
                    <tr
                      key={r.month}
                      style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                    >
                      <td style={{ padding: '0.3rem 0.5rem', fontWeight: 600 }}>{r.month}</td>
                      <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                        {r.new_count}
                      </td>
                      <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                        {r.returning_count}
                      </td>
                      <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>{pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Referral conversion rate — clicks vs contributions (#593) */}
      {dashAnalytics?.referral_conversion?.length > 0 && (
        <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
          <strong style={{ display: 'block', marginBottom: '0.6rem' }}>Referral Conversion</strong>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.3rem 0.5rem' }}>Referral Code</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Clicks</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Contributions</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Conversion</th>
                </tr>
              </thead>
              <tbody>
                {dashAnalytics.referral_conversion.map((r) => (
                  <tr
                    key={r.referral_code}
                    style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                  >
                    <td
                      style={{
                        padding: '0.3rem 0.5rem',
                        fontFamily: 'monospace',
                        fontSize: '0.78rem',
                      }}
                    >
                      {r.referral_code}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {r.click_count}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {r.contribution_count}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {r.conversion_rate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
