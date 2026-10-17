import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

const MiniLineChart = React.lazy(() => import('../components/MiniLineChart'));

import { XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

function StatCard({ label, value }) {
  return (
    <div className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.75rem' }}>
      <strong style={{ fontSize: '1rem' }}>{value}</strong>
      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>{label}</div>
    </div>
  );
}

function BenchmarkBar({ creator, platform, label }) {
  const maxVal = Math.max(creator || 0, platform || 0, 1);
  return (
    <div style={{ marginBottom: '0.6rem' }}>
      <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.25rem' }}>{label}</div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.15rem' }}
      >
        <span style={{ fontSize: '0.75rem', width: 60, color: 'var(--color-text-secondary)' }}>
          You
        </span>
        <div style={{ flex: 1, background: 'var(--color-surface)', borderRadius: 4, height: 12 }}>
          <div
            style={{
              width: `${(creator / maxVal) * 100}%`,
              height: 12,
              borderRadius: 4,
              background: 'var(--color-accent)',
            }}
          />
        </div>
        <span style={{ fontSize: '0.75rem', width: 50, textAlign: 'right' }}>
          {creator?.toFixed(1) ?? '—'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', width: 60, color: 'var(--color-text-hint)' }}>
          Platform
        </span>
        <div style={{ flex: 1, background: 'var(--color-surface)', borderRadius: 4, height: 12 }}>
          <div
            style={{
              width: `${(platform / maxVal) * 100}%`,
              height: 12,
              borderRadius: 4,
              background: '#94a3b8',
            }}
          />
        </div>
        <span style={{ fontSize: '0.75rem', width: 50, textAlign: 'right' }}>
          {platform?.toFixed(1) ?? '—'}
        </span>
      </div>
    </div>
  );
}

export default function CreatorAnalytics() {
  const { user, ready } = useAuth();
  const { t } = useTranslation();
  const [overview, setOverview] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [benchmarks, setBenchmarks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState('goal_pct');
  const [sortDir, setSortDir] = useState('desc');

  const isCreator = user?.role === 'creator' || user?.role === 'admin';

  useEffect(() => {
    if (!user || !isCreator) return;
    setLoading(true);
    Promise.all([
      api.getCreatorAnalyticsOverview(),
      api.getMyCampaigns({ limit: 50 }),
      api.getCreatorBenchmarks(),
    ])
      .then(([ov, campRes, bm]) => {
        setOverview(ov);
        setCampaigns(Array.isArray(campRes) ? campRes : campRes?.data || []);
        setBenchmarks(bm);
      })
      .catch((err) => setError(err.message || 'Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [user, isCreator]);

  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isCreator) return <Navigate to="/dashboard" replace />;

  function toggleSort(field) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  const campaignsWithGoal = campaigns.map((c) => ({
    ...c,
    goal_pct:
      Number(c.target_amount) > 0
        ? Math.min(100, (Number(c.raised_amount) / Number(c.target_amount)) * 100)
        : 0,
    contributor_count: c.contributor_count ?? 0,
  }));

  const sorted = [...campaignsWithGoal].sort((a, b) => {
    const av = a[sortField] ?? 0;
    const bv = b[sortField] ?? 0;
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  const benchmarkComparisons = benchmarks?.comparisons || [];
  const avgCreatorGoalPct =
    benchmarkComparisons.length > 0
      ? benchmarkComparisons.reduce((s, c) => s + (c.creator?.goal_pct || 0), 0) /
        benchmarkComparisons.length
      : 0;
  const avgPlatformGoalPct =
    benchmarkComparisons.filter((c) => c.platform).length > 0
      ? benchmarkComparisons
          .filter((c) => c.platform)
          .reduce((s, c) => s + (c.platform?.avg_goal_pct || 0), 0) /
        benchmarkComparisons.filter((c) => c.platform).length
      : 0;

  const avgCreatorTimeFirst =
    benchmarkComparisons.filter(
      (c) =>
        c.creator?.time_to_first_contribution_hours !== null &&
        c.creator?.time_to_first_contribution_hours !== undefined
    ).length > 0
      ? benchmarkComparisons
          .filter(
            (c) =>
              c.creator?.time_to_first_contribution_hours !== null &&
              c.creator?.time_to_first_contribution_hours !== undefined
          )
          .reduce((s, c) => s + c.creator.time_to_first_contribution_hours, 0) /
        benchmarkComparisons.filter(
          (c) =>
            c.creator?.time_to_first_contribution_hours !== null &&
            c.creator?.time_to_first_contribution_hours !== undefined
        ).length
      : null;
  const avgPlatformTimeFirst =
    benchmarkComparisons.filter(
      (c) =>
        c.platform?.avg_time_to_first_contribution_hours !== null &&
        c.platform?.avg_time_to_first_contribution_hours !== undefined
    ).length > 0
      ? benchmarkComparisons
          .filter(
            (c) =>
              c.platform?.avg_time_to_first_contribution_hours !== null &&
              c.platform?.avg_time_to_first_contribution_hours !== undefined
          )
          .reduce((s, c) => s + c.platform.avg_time_to_first_contribution_hours, 0) /
        benchmarkComparisons.filter(
          (c) =>
            c.platform?.avg_time_to_first_contribution_hours !== null &&
            c.platform?.avg_time_to_first_contribution_hours !== undefined
        ).length
      : null;

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '1.25rem',
        }}
      >
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800 }}>Creator Analytics</h1>
        <Link
          to="/dashboard?tab=analytics"
          style={{ color: 'var(--color-accent)', fontWeight: 600, fontSize: '0.9rem' }}
        >
          Back to Dashboard
        </Link>
      </div>

      {error && <p className="alert alert--error">{error}</p>}
      {loading && <p style={{ color: 'var(--color-text-hint)' }}>{t('common.loading')}</p>}

      {overview && !loading && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: '0.75rem',
              marginBottom: '1.25rem',
            }}
          >
            <StatCard
              label="Total Raised"
              value={`${Number(overview.total_raised).toLocaleString()}`}
            />
            <StatCard label="Unique Contributors" value={overview.unique_contributors} />
            <StatCard label="Total Campaigns" value={overview.total_campaigns} />
            <StatCard label="Active" value={overview.active_campaigns} />
            <StatCard label="Completed" value={overview.completed_campaigns} />
            <StatCard label="Expired" value={overview.expired_campaigns} />
            <StatCard
              label="Avg Contribution"
              value={Number(overview.avg_contribution).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            />
            <StatCard
              label="7-Day Velocity"
              value={Number(overview.velocity_7d_avg).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            />
            <StatCard
              label="30-Day Velocity"
              value={Number(overview.velocity_30d_avg).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            />
          </div>

          {overview.best_performing_campaign && (
            <div className="campaign-card" style={{ minHeight: 'auto', marginBottom: '1.25rem' }}>
              <strong style={{ display: 'block', marginBottom: '0.4rem' }}>
                Best Performing Campaign
              </strong>
              <Link
                to={`/campaigns/${overview.best_performing_campaign.id}`}
                style={{ color: 'var(--color-accent)', fontWeight: 600 }}
              >
                {overview.best_performing_campaign.title}
              </Link>
              <div
                style={{
                  fontSize: '0.88rem',
                  marginTop: '0.25rem',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {overview.best_performing_campaign.goal_pct}% of goal reached
                {' · '}
                {Number(overview.best_performing_campaign.raised_amount).toLocaleString()} /{' '}
                {Number(overview.best_performing_campaign.target_amount).toLocaleString()}{' '}
                {overview.best_performing_campaign.asset_type}
              </div>
            </div>
          )}

          <div className="campaign-card" style={{ minHeight: 'auto', marginBottom: '1.25rem' }}>
            <strong style={{ display: 'block', marginBottom: '0.6rem' }}>
              30-Day Velocity Trend
            </strong>
            <React.Suspense
              fallback={
                <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
                  Loading chart…
                </p>
              }
            >
              <MiniLineChart
                data={
                  overview.velocity_30d_avg
                    ? [
                        { day: '30d avg', total_amount: overview.velocity_30d_avg },
                        { day: '7d avg', total_amount: overview.velocity_7d_avg },
                      ]
                    : []
                }
                dataKey="total_amount"
                label="Amount"
              />
            </React.Suspense>
          </div>
        </>
      )}

      {campaigns.length > 0 && !loading && (
        <div className="campaign-card" style={{ minHeight: 'auto', marginBottom: '1.25rem' }}>
          <strong style={{ display: 'block', marginBottom: '0.6rem' }}>Campaign Performance</strong>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                  {[
                    { key: 'title', label: 'Campaign' },
                    { key: 'goal_pct', label: 'Goal %' },
                    { key: 'raised_amount', label: 'Raised' },
                    { key: 'target_amount', label: 'Target' },
                    { key: 'contributor_count', label: 'Contributors' },
                    { key: 'status', label: 'Status' },
                  ].map(({ key, label }) => (
                    <th
                      key={key}
                      onClick={() => key !== 'title' && key !== 'status' && toggleSort(key)}
                      style={{
                        padding: '0.4rem 0.5rem',
                        cursor: key !== 'title' && key !== 'status' ? 'pointer' : 'default',
                        userSelect: 'none',
                      }}
                    >
                      {label}
                      {sortField === key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--color-border-lighter)' }}>
                    <td style={{ padding: '0.4rem 0.5rem' }}>
                      <Link
                        to={`/dashboard/analytics/${c.id}`}
                        style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                      >
                        {c.title}
                      </Link>
                    </td>
                    <td style={{ padding: '0.4rem 0.5rem' }}>{c.goal_pct.toFixed(1)}%</td>
                    <td style={{ padding: '0.4rem 0.5rem' }}>
                      {Number(c.raised_amount).toLocaleString()}
                    </td>
                    <td style={{ padding: '0.4rem 0.5rem' }}>
                      {Number(c.target_amount).toLocaleString()}
                    </td>
                    <td style={{ padding: '0.4rem 0.5rem' }}>{c.contributor_count}</td>
                    <td style={{ padding: '0.4rem 0.5rem' }}>{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {benchmarks && !loading && benchmarkComparisons.length > 0 && (
        <div className="campaign-card" style={{ minHeight: 'auto' }}>
          <strong style={{ display: 'block', marginBottom: '0.6rem' }}>Platform Benchmarks</strong>
          <p
            style={{
              fontSize: '0.82rem',
              color: 'var(--color-text-hint)',
              marginBottom: '0.75rem',
            }}
          >
            Your campaign averages compared to anonymised platform medians (minimum 10 campaigns per
            bracket).
          </p>
          <BenchmarkBar
            creator={avgCreatorGoalPct}
            platform={avgPlatformGoalPct}
            label="Avg Goal % Reached"
          />
          {avgCreatorTimeFirst !== null && avgPlatformTimeFirst !== null && (
            <BenchmarkBar
              creator={avgCreatorTimeFirst}
              platform={avgPlatformTimeFirst}
              label="Avg Time to First Contribution (hours)"
            />
          )}
          <div style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.3rem 0.5rem' }}>Campaign</th>
                  <th style={{ padding: '0.3rem 0.5rem' }}>Bracket</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Your Goal %</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Platform Avg %</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Your Time (hrs)</th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                    Platform Time (hrs)
                  </th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                    Your Contributors
                  </th>
                  <th style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>Platform Avg</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkComparisons.map((bm) => (
                  <tr
                    key={bm.campaign_id}
                    style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                  >
                    <td style={{ padding: '0.3rem 0.5rem' }}>
                      <Link
                        to={`/dashboard/analytics/${bm.campaign_id}`}
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {campaigns.find((c) => c.id === bm.campaign_id)?.title || bm.campaign_id}
                      </Link>
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem' }}>{bm.bracket}</td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {bm.creator?.goal_pct?.toFixed(1) ?? '—'}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {bm.platform?.avg_goal_pct?.toFixed(1) ?? '—'}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {bm.creator?.time_to_first_contribution_hours?.toFixed(1) ?? '—'}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {bm.platform?.avg_time_to_first_contribution_hours?.toFixed(1) ?? '—'}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {bm.creator?.contributor_count ?? '—'}
                    </td>
                    <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                      {bm.platform?.avg_contributor_count?.toFixed(1) ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
