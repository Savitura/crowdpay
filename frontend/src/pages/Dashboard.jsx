import { useEffect, useState, useCallback } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import KycPrompt from '../components/KycPrompt';
import VerificationBadge from '../components/VerificationBadge';
import CampaignStatusBadge from '../components/CampaignStatusBadge';
import ContributorDashboard from '../components/ContributorDashboard';
import DepositModal from '../components/DepositModal';
import ApiKeysPanel from '../components/ApiKeysPanel';
import { stellarExpertAccountUrl } from '../config/stellar';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

const TABS = [
  { id: 'campaigns', labelKey: 'dashboard.tabs.campaigns' },
  { id: 'contributions', labelKey: 'dashboard.tabs.contributions' },
  { id: 'analytics', labelKey: 'dashboard.tabs.analytics' },
  { id: 'api-keys', labelKey: 'dashboard.tabs.apiKeys' },
];

function progressPct(campaign) {
  if (!Number(campaign.target_amount)) return 0;
  return Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100);
}

function exportCSV(rows, filename) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const csv = [
    keys.join(','),
    ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(',')),
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

function MiniLineChart({ data, dataKey = 'total_amount', label = '' }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) {
    return (
      <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
        {t('dashboard.noContributionData')}
      </p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d) => d?.slice(5)} />
        <YAxis tick={{ fontSize: 11 }} width={48} />
        <Tooltip formatter={(v) => [Number(v).toLocaleString(), label]} />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke="var(--color-accent)"
          dot={false}
          strokeWidth={2}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MilestoneFunnel({ campaignId }) {
  const { t } = useTranslation();
  const [milestones, setMilestones] = useState(null);
  const [campaign, setCampaign] = useState(null);

  useEffect(() => {
    Promise.all([api.getMilestones(campaignId), api.getCampaign(campaignId)])
      .then(([ms, c]) => {
        setMilestones(ms);
        setCampaign(c);
      })
      .catch(() => {});
  }, [campaignId]);

  if (!milestones || milestones.length === 0) return null;

  const raised = Number(campaign?.raised_amount || 0);
  const target = Number(campaign?.target_amount || 1);

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <strong style={{ fontSize: '0.9rem' }}>{t('dashboard.milestoneFunnel')}</strong>
      {milestones.map((m) => {
        const threshold = (Number(m.release_percentage) / 100) * target;
        const pct = Math.min(100, (raised / threshold) * 100);
        return (
          <div key={m.id} style={{ marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
              <span>{m.title}</span>
              <span style={{ color: 'var(--color-text-hint)' }}>
                {m.release_percentage}% ·{' '}
                {t('dashboard.percentFunded', { percent: pct.toFixed(0) })}
              </span>
            </div>
            <div
              style={{
                background: 'var(--color-surface)',
                borderRadius: 99,
                height: 6,
                marginTop: 3,
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: 6,
                  borderRadius: 99,
                  background: m.status === 'released' ? '#22c55e' : 'var(--color-accent)',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { user, ready, updateUser } = useAuth();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab =
    tabParam === 'contributions'
      ? 'contributions'
      : tabParam === 'referrals'
        ? 'referrals'
        : 'campaigns';

  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loadingContributions, setLoadingContributions] = useState(false);
  const [error, setError] = useState('');
  const [balance, setBalance] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [dashAnalytics, setDashAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [campaignAnalytics, setCampaignAnalytics] = useState(null);
  const [campaignContributors, setCampaignContributors] = useState(null);
  const [referralData, setReferralData] = useState({});
  const [referralLoading, setReferralLoading] = useState(false);
  const [exportingCampaignId, setExportingCampaignId] = useState(null);
  const [togglingVisibility, setTogglingVisibility] = useState(null);

  const isCreator = user?.role === 'creator' || user?.role === 'admin';

  const visibleTabs = isCreator
    ? [...TABS, { id: 'referrals', labelKey: 'dashboard.tabs.referrals' }]
    : TABS.filter((t) => t.id !== 'analytics');

  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';

  useEffect(() => {
    if (!user) return;
    setLoadingCampaigns(true);
    setError('');

    api
      .getMyBalance()
      .then((d) => setBalance(d.balance))
      .catch(() => {})
      .finally(() => setBalanceLoading(false));

    if (isCreator) {
      Promise.all([api.getMe(), api.getMyStats(), api.getMyCampaigns()])
        .then(([me, s, c]) => {
          updateUser(me);
          setStats(s);
          setCampaigns(c);
          // pre-fetch dashboard analytics for the analytics tab
          api
            .getUserDashboardAnalytics()
            .then(setDashAnalytics)
            .catch(() => {});
        })
        .catch((err) => setError(err.message || 'Could not load dashboard'))
        .finally(() => {
          setLoadingCampaigns(false);
        });
    } else {
      setLoadingCampaigns(false);
      setLoadingContributions(false);
    }
  }, [isCreator, user, updateUser]);

  const loadCampaignAnalytics = useCallback((id) => {
    setSelectedCampaignId(id);
    setCampaignAnalytics(null);
    setCampaignContributors(null);
    setAnalyticsLoading(true);
    Promise.all([api.getCampaignAnalytics(id), api.getCampaignAnalyticsContributors(id)])
      .then(([a, c]) => {
        setCampaignAnalytics(a);
        setCampaignContributors(c);
      })
      .catch(() => {})
      .finally(() => setAnalyticsLoading(false));
  }, []);

  const handleExportContributions = useCallback(async (campaign) => {
    setError('');
    setExportingCampaignId(campaign.id);
    try {
      const { blob, filename } = await api.exportCampaignContributions(campaign.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Could not export campaign contributors');
    } finally {
      setExportingCampaignId(null);
    }
  }, []);

  const handleToggleVisibility = useCallback(async (campaign) => {
    setError('');
    setTogglingVisibility(campaign.id);
    try {
      const newHidden = !campaign.is_hidden;
      await api.toggleCampaignVisibility(campaign.id, newHidden);
      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === campaign.id ? { ...c, is_hidden: newHidden } : c
        )
      );
    } catch (err) {
      setError(err.message || 'Could not change campaign visibility');
    } finally {
      setTogglingVisibility(null);
    }
  }, []);

  useEffect(() => {
    if (!isCreator || activeTab !== 'referrals' || !campaigns.length) return;
    setReferralLoading(true);
    Promise.all(
      campaigns.map((c) =>
        api
          .getReferralLeaderboard(c.id)
          .then((rows) => [c.id, rows])
          .catch(() => [c.id, []])
      )
    )
      .then((results) => {
        const data = {};
        results.forEach(([id, rows]) => {
          data[id] = rows;
        });
        setReferralData(data);
      })
      .catch(() => {})
      .finally(() => setReferralLoading(false));
  }, [isCreator, activeTab, campaigns]);

  useEffect(() => {
    const kycParam = searchParams.get('kyc');
    if (!user || (kycParam !== 'returned' && kycParam !== 'started')) return undefined;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 40;

    async function pollKycStatus() {
      while (!cancelled && attempts < maxAttempts) {
        attempts += 1;
        try {
          const status = await api.getKycStatus();
          if (status.status === 'verified' || status.status === 'rejected') {
            const me = await api.getMe();
            updateUser(me);
            setSearchParams(
              (params) => {
                params.delete('kyc');
                params.delete('reference');
                return params;
              },
              { replace: true }
            );
            break;
          }
        } catch {
          // keep polling until Persona webhook lands
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    pollKycStatus();
    return () => {
      cancelled = true;
    };
  }, [user, searchParams, updateUser, setSearchParams]);

  function setTab(tabId) {
    if (tabId === 'contributions') {
      setSearchParams({ tab: 'contributions' });
    } else if (tabId === 'analytics') {
      setSearchParams({ tab: 'analytics' });
    } else if (tabId === 'referrals') {
      setSearchParams({ tab: 'referrals' });
    } else if (tabId === 'api-keys') {
      setSearchParams({ tab: 'api-keys' });
    } else {
      setSearchParams({});
    }
  }

  if (!ready) {
    return (
      <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
        <p style={{ color: 'var(--color-text-hint)' }}>{t('dashboard.restoringSession')}</p>
      </main>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  const loading = activeTab === 'campaigns' ? loadingCampaigns : loadingContributions;

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>
        {t('dashboard.title')}
      </h1>

      <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div>
            <strong>{t('dashboard.walletBalance')}</strong>
            <div
              style={{ color: 'var(--color-text-hint)', fontSize: '0.88rem', marginTop: '0.2rem' }}
            >
              {balanceLoading
                ? t('common.loading')
                : balance
                  ? Object.entries(balance)
                      .filter(([, v]) => Number(v) > 0)
                      .map(([code, val]) => `${Number(val).toLocaleString()} ${code}`)
                      .join(' · ') || t('dashboard.noFunds')
                  : t('dashboard.noFunds')}
              {user?.wallet_public_key && (
                <span style={{ marginLeft: '0.5rem' }}>
                  ·{' '}
                  <a
                    href={stellarExpertAccountUrl(user.wallet_public_key)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    {t('dashboard.viewOnStellarExpert')}
                  </a>
                </span>
              )}
            </div>
          </div>
          <button type="button" className="btn-primary" onClick={() => setShowDepositModal(true)}>
            {t('dashboard.addFunds')}
          </button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label={t('dashboard.sectionsLabel')}
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.25rem',
          borderBottom: '1px solid var(--color-border)',
          paddingBottom: '0.5rem',
        }}
      >
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setTab(tab.id)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: activeTab === tab.id ? 'var(--color-accent)' : 'transparent',
              color: activeTab === tab.id ? '#fff' : 'var(--color-text-secondary)',
            }}
          >
            {tab.label ? tab.label : t(tab.labelKey)}
          </button>
        ))}
      </div>

      {error && <p className="alert alert--error">{error}</p>}

      {activeTab === 'campaigns' && (
        <section role="tabpanel" aria-labelledby="tab-campaigns">
          {loading ? (
            <p style={{ color: 'var(--color-text-hint)' }}>{t('dashboard.loadingCampaigns')}</p>
          ) : !isCreator ? (
            <p className="alert alert--info">
              {t('dashboard.noCreatedCampaigns')}{' '}
              <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                {t('home.startCampaign')}
              </Link>{' '}
              {t('dashboard.noCreatedCampaignsHint')}
            </p>
          ) : (
            <>
              <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <strong>{t('dashboard.identityVerification')}</strong>
                    <div
                      style={{
                        color: 'var(--color-text-hint)',
                        fontSize: '0.88rem',
                        marginTop: '0.2rem',
                      }}
                    >
                      {t('dashboard.status')}: {user?.kyc_status || t('dashboard.unverified')}
                      {user?.kyc_completed_at
                        ? ` • ${t('dashboard.completedOn', { date: new Date(user.kyc_completed_at).toLocaleDateString() })}`
                        : ''}
                    </div>
                  </div>
                  <VerificationBadge status={user?.kyc_status} />
                </div>
                {kycRequired && user?.kyc_status !== 'verified' && (
                  <div style={{ marginTop: '0.85rem' }}>
                    <KycPrompt onUserUpdate={updateUser} />
                  </div>
                )}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
                  gap: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <div className="campaign-card">
                  <strong>{stats?.total_campaigns || 0}</strong>
                  <div>{t('dashboard.totalCampaigns')}</div>
                </div>
                <div className="campaign-card">
                  <strong>{Number(stats?.total_raised || 0).toLocaleString()}</strong>
                  <div>{t('dashboard.totalRaised')}</div>
                </div>
                <div className="campaign-card">
                  <strong>{stats?.active_campaigns || 0}</strong>
                  <div>{t('dashboard.active')}</div>
                </div>
                <div className="campaign-card">
                  <strong>{stats?.funded_campaigns || 0}</strong>
                  <div>{t('dashboard.funded')}</div>
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                  {t('dashboard.createNewCampaign')}
                </Link>
              </div>

              {campaigns.length === 0 ? (
                <p className="alert alert--info">{t('dashboard.noCampaigns')}</p>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {campaigns.map((campaign) => {
                    const pct = progressPct(campaign).toFixed(1);
                    return (
                      <div
                        key={campaign.id}
                        className="campaign-card"
                        style={campaign.is_hidden ? { opacity: 0.6 } : undefined}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: '0.5rem',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                          }}
                        >
                          <strong>{campaign.title}</strong>
                          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                            {campaign.is_hidden && (
                              <span
                                style={{
                                  fontSize: '0.72rem',
                                  fontWeight: 700,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.04em',
                                  padding: '0.15rem 0.5rem',
                                  borderRadius: '99px',
                                  background: 'var(--color-surface)',
                                  color: 'var(--color-text-hint)',
                                  opacity: 0.6,
                                }}
                              >
                                Hidden
                              </span>
                            )}
                            <CampaignStatusBadge status={campaign.status} />
                          </div>
                        </div>
                        <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                          {Number(campaign.raised_amount).toLocaleString()} /{' '}
                          {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}
                        </div>
                        <div
                          style={{
                            background: 'var(--color-surface)',
                            borderRadius: '99px',
                            height: '6px',
                            marginTop: '0.35rem',
                          }}
                        >
                          <div
                            style={{
                              background: 'var(--color-accent)',
                              height: '6px',
                              borderRadius: '99px',
                              width: `${pct}%`,
                            }}
                          />
                        </div>
                        <div
                          style={{
                            marginTop: '0.35rem',
                            color: 'var(--color-text-hint)',
                            fontSize: '0.85rem',
                          }}
                        >
                          {t('dashboard.contributorsCount', { count: campaign.contributor_count })}
                          {campaign.deadline
                            ? ` • ${t('dashboard.deadline', { date: new Date(campaign.deadline).toLocaleDateString() })}`
                            : ''}
                        </div>
                        <div
                          style={{
                            marginTop: '0.6rem',
                            display: 'flex',
                            gap: '0.75rem',
                            flexWrap: 'wrap',
                          }}
                        >
                          <Link
                            to={`/campaigns/${campaign.id}`}
                            style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                          >
                            {t('dashboard.viewCampaign')}
                          </Link>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={exportingCampaignId !== null}
                            aria-busy={exportingCampaignId === campaign.id}
                            onClick={() => handleExportContributions(campaign)}
                            style={{ fontSize: '0.82rem', padding: '0.3rem 0.8rem' }}
                          >
                            {exportingCampaignId === campaign.id
                              ? t('common.loading')
                              : t('dashboard.exportCsv')}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={togglingVisibility !== null}
                            aria-busy={togglingVisibility === campaign.id}
                            onClick={() => handleToggleVisibility(campaign)}
                            style={{ fontSize: '0.82rem', padding: '0.3rem 0.8rem' }}
                          >
                            {togglingVisibility === campaign.id
                              ? t('common.loading')
                              : campaign.is_hidden
                                ? t('dashboard.showCampaign')
                                : t('dashboard.hideCampaign')}
                          </button>
                          {campaign.status === 'funded' && (
                            <Link
                              to={`/campaigns/${campaign.id}#withdrawals`}
                              style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                            >
                              {campaign.has_milestones
                                ? t('dashboard.manageMilestoneReleases')
                                : t('dashboard.requestWithdrawal')}
                            </Link>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === 'contributions' && (
        <section role="tabpanel" aria-labelledby="tab-contributions">
          <ContributorDashboard />
        </section>
      )}

      {activeTab === 'analytics' && isCreator && (
        <section role="tabpanel" aria-labelledby="tab-analytics">
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
                  onClick={() => exportCSV(dashAnalytics.recent_trend, 'contributions_trend.csv')}
                >
                  {t('dashboard.exportCsv')}
                </button>
              )}
            </div>
            <MiniLineChart
              data={dashAnalytics?.recent_trend}
              dataKey="total_amount"
              label={t('dashboard.amount')}
            />
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
                    <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

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
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => loadCampaignAnalytics(c.id)}
                    style={{
                      padding: '0.3rem 0.75rem',
                      borderRadius: 8,
                      border: '1px solid var(--color-border)',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '0.82rem',
                      background:
                        selectedCampaignId === c.id ? 'var(--color-accent)' : 'transparent',
                      color: selectedCampaignId === c.id ? '#fff' : 'var(--color-text-secondary)',
                    }}
                  >
                    {c.title}
                  </button>
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
                    <strong style={{ fontSize: '0.9rem' }}>
                      {t('dashboard.contributorStats')}
                    </strong>
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

                {/* Time-series chart */}
                <strong style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>
                  {t('dashboard.contributionsOverTime')}
                </strong>
                <MiniLineChart
                  data={campaignAnalytics.daily_buckets}
                  dataKey="total_amount"
                  label={t('dashboard.amount')}
                />

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
              </>
            )}
          </div>
        </section>
      )}

      {activeTab === 'referrals' && isCreator && (
        <section role="tabpanel" aria-labelledby="tab-referrals">
          {referralLoading ? (
            <p style={{ color: 'var(--color-text-hint)' }}>{t('dashboard.loadingReferrals')}</p>
          ) : campaigns.length === 0 ? (
            <p className="alert alert--info">
              {t('dashboard.noReferralCampaigns')}{' '}
              <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                {t('dashboard.createCampaign')}
              </Link>{' '}
              {t('dashboard.startTrackingReferrals')}
            </p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {campaigns.map((campaign) => {
                const refs = referralData[campaign.id] || [];
                const totalClicks = refs.reduce((s, r) => s + r.click_count, 0);
                const totalContributions = refs.reduce((s, r) => s + r.contribution_count, 0);
                return (
                  <div key={campaign.id} className="campaign-card">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <Link
                        to={`/campaigns/${campaign.id}`}
                        style={{ color: 'var(--color-accent)', fontWeight: 700 }}
                      >
                        {campaign.title}
                      </Link>
                      <CampaignStatusBadge status={campaign.status} />
                    </div>
                    {refs.length === 0 ? (
                      <p style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem' }}>
                        {t('dashboard.noReferralActivity')}
                      </p>
                    ) : (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            gap: '1rem',
                            marginBottom: '0.75rem',
                            fontSize: '0.85rem',
                          }}
                        >
                          <span>
                            <strong>{totalClicks}</strong> {t('dashboard.totalClicks')}
                          </span>
                          <span>
                            <strong>{totalContributions}</strong> {t('dashboard.totalConversions')}
                          </span>
                        </div>
                        <table
                          style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}
                        >
                          <thead>
                            <tr
                              style={{
                                borderBottom: '2px solid var(--color-border)',
                                textAlign: 'left',
                              }}
                            >
                              <th style={{ padding: '0.35rem 0.5rem' }}>
                                {t('dashboard.referrer')}
                              </th>
                              <th style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                                {t('dashboard.clicks')}
                              </th>
                              <th style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                                {t('dashboard.conversions')}
                              </th>
                              <th style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                                {t('dashboard.rate')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {refs.map((r) => (
                              <tr
                                key={r.referral_code}
                                style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                              >
                                <td style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>
                                  {r.referrer_name}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                                  {r.click_count}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                                  {r.contribution_count}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                                  {r.click_count > 0
                                    ? `${((r.contribution_count / r.click_count) * 100).toFixed(0)}%`
                                    : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === 'api-keys' && <ApiKeysPanel />}

      {showDepositModal && (
        <DepositModal
          onClose={() => setShowDepositModal(false)}
          onSuccess={() => {
            api
              .getMyBalance()
              .then((d) => setBalance(d.balance))
              .catch(() => {});
          }}
        />
      )}
    </main>
  );
}
