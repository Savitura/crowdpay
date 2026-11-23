import { useEffect, useState, useCallback } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import ContributorDashboard from '../components/ContributorDashboard';
import SubscriptionsPanel from '../components/SubscriptionsPanel';
import FollowedCampaigns from '../components/FollowedCampaigns';
import DepositModal from '../components/DepositModal';
import ApiKeysPanel from '../components/ApiKeysPanel';
import ThankYouModal from '../components/ThankYouModal';
import CreatorOnboardingChecklist from '../components/CreatorOnboardingChecklist';
import { exportCSV } from '../lib/dashboardHelpers';
import WalletBalanceCard from '../components/dashboard/WalletBalanceCard';
import DashboardTabs from '../components/dashboard/DashboardTabs';
import IdentityVerificationCard from '../components/dashboard/IdentityVerificationCard';
import CreatorStatsGrid from '../components/dashboard/CreatorStatsGrid';
import CampaignList from '../components/dashboard/CampaignList';
import AnalyticsOverview from '../components/dashboard/AnalyticsOverview';
import PerCampaignAnalytics from '../components/dashboard/PerCampaignAnalytics';
import ReferralsPanel from '../components/dashboard/ReferralsPanel';
import ThankYouToast from '../components/dashboard/ThankYouToast';

const TABS = [
  { id: 'campaigns', labelKey: 'dashboard.tabs.campaigns' },
  { id: 'contributions', labelKey: 'dashboard.tabs.contributions' },
  { id: 'subscriptions', labelKey: 'dashboard.tabs.subscriptions' },
  { id: 'following', labelKey: 'dashboard.tabs.following' },
  { id: 'analytics', labelKey: 'dashboard.tabs.analytics' },
  { id: 'api-keys', labelKey: 'dashboard.tabs.apiKeys' },
];

export default function Dashboard() {
  const { user, ready, updateUser } = useAuth();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab =
    tabParam === 'contributions'
      ? 'contributions'
      : tabParam === 'subscriptions'
        ? 'subscriptions'
        : tabParam === 'following'
          ? 'following'
          : tabParam === 'referrals'
            ? 'referrals'
            : tabParam === 'analytics'
              ? 'analytics'
              : tabParam === 'api-keys'
                ? 'api-keys'
                : 'campaigns';

  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [campaignsPage, setCampaignsPage] = useState(1);
  const [campaignsTotalPages, setCampaignsTotalPages] = useState(1);
  const [campaignsTotal, setCampaignsTotal] = useState(0);
  const [isCampaignsPageLoading, setIsCampaignsPageLoading] = useState(false);
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
  const [campaignBackers, setCampaignBackers] = useState(null);
  const [exportingCampaignId, setExportingCampaignId] = useState(null);
  const [bulkThankYouCampaignId, setBulkThankYouCampaignId] = useState(null);
  const [individualThankYouContribution, setIndividualThankYouContribution] = useState(null);
  const [campaignContributions, setCampaignContributions] = useState([]);
  const [contributionsLoading, setContributionsLoading] = useState(false);
  const [thankYouSent, setThankYouSent] = useState('');
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
    setLoadingContributions(true);
    setError('');

    api
      .getMyBalance()
      .then((d) => setBalance(d.balance))
      .catch(() => {})
      .finally(() => setBalanceLoading(false));

    if (isCreator) {
      Promise.all([api.getMe(), api.getMyStats()])
        .then(([me, s]) => {
          updateUser(me);
          setStats(s);
          // pre-fetch dashboard analytics for the analytics tab
          api
            .getUserDashboardAnalytics()
            .then(setDashAnalytics)
            .catch(() => {});
        })
        .catch((err) => setError(err.message || 'Could not load dashboard'))
        .finally(() => {
          setLoadingCampaigns(false);
          setLoadingContributions(false);
        });
    } else {
      setLoadingCampaigns(false);
      setLoadingContributions(false);
    }
  }, [isCreator, user, updateUser]);

  useEffect(() => {
    if (!user || !isCreator) return;
    setIsCampaignsPageLoading(true);
    api
      .getMyCampaigns({ page: campaignsPage, limit: 20 })
      .then((res) => {
        if (res.data && res.pagination) {
          setCampaigns(res.data);
          setCampaignsTotalPages(res.pagination.totalPages);
          setCampaignsTotal(res.pagination.total);
        } else {
          setCampaigns(res);
          setCampaignsTotalPages(1);
          setCampaignsTotal(res.length || 0);
        }
      })
      .catch((err) => setError(err.message || 'Could not load campaigns'))
      .finally(() => {
        setLoadingCampaigns(false);
        setIsCampaignsPageLoading(false);
      });
  }, [isCreator, user, campaignsPage]);

  const loadCampaignAnalytics = useCallback((id) => {
    setSelectedCampaignId(id);
    setCampaignAnalytics(null);
    setCampaignContributors(null);
    setCampaignContributions([]);
    setAnalyticsLoading(true);
    setContributionsLoading(true);
    Promise.all([
      api.getCampaignAnalytics(id),
      api.getCampaignAnalyticsContributors(id),
      api.getContributions(id, { limit: 100 }),
    ])
      .then(([a, c, ctr]) => {
        setCampaignAnalytics(a);
        setCampaignContributors(c);
        setCampaignContributions(ctr.contributions || []);
      })
      .catch(() => {})
      .finally(() => {
        setAnalyticsLoading(false);
        setContributionsLoading(false);
      });
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
        prev.map((c) => (c.id === campaign.id ? { ...c, is_hidden: newHidden } : c))
      );
    } catch (err) {
      setError(err.message || 'Could not change campaign visibility');
    } finally {
      setTogglingVisibility(null);
    }
  }, []);

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
    } else if (tabId === 'subscriptions') {
      setSearchParams({ tab: 'subscriptions' });
    } else if (tabId === 'following') {
      setSearchParams({ tab: 'following' });
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

      {isCreator && <CreatorOnboardingChecklist user={user} campaigns={campaigns} stats={stats} />}
      <WalletBalanceCard
        balance={balance}
        balanceLoading={balanceLoading}
        walletPublicKey={user?.wallet_public_key}
        onAddFunds={() => setShowDepositModal(true)}
      />

      <DashboardTabs tabs={visibleTabs} activeTab={activeTab} onTabChange={setTab} />

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
              <IdentityVerificationCard
                user={user}
                kycRequired={kycRequired}
                onUserUpdate={updateUser}
              />

              <CreatorStatsGrid stats={stats} />

              <CampaignList
                campaigns={campaigns}
                loading={loading}
                isCreator={isCreator}
                isCampaignsPageLoading={isCampaignsPageLoading}
                campaignsPage={campaignsPage}
                campaignsTotalPages={campaignsTotalPages}
                campaignsTotal={campaignsTotal}
                setCampaignsPage={setCampaignsPage}
                exportingCampaignId={exportingCampaignId}
                togglingVisibility={togglingVisibility}
                onExportContributions={handleExportContributions}
                onToggleVisibility={handleToggleVisibility}
                onBulkThankYou={setBulkThankYouCampaignId}
              />
            </>
          )}
        </section>
      )}

      {activeTab === 'contributions' && (
        <section role="tabpanel" aria-labelledby="tab-contributions">
          <ContributorDashboard />
        </section>
      )}

      {activeTab === 'subscriptions' && (
        <section role="tabpanel" aria-labelledby="tab-subscriptions">
          <SubscriptionsPanel />
        </section>
      )}

      {activeTab === 'following' && (
        <section role="tabpanel" aria-labelledby="tab-following">
          <FollowedCampaigns />
        </section>
      )}
      {activeTab === 'analytics' && isCreator && (
        <section role="tabpanel" aria-labelledby="tab-analytics">
          <AnalyticsOverview dashAnalytics={dashAnalytics} onExport={exportCSV} />

          <PerCampaignAnalytics
            campaigns={campaigns}
            selectedCampaignId={selectedCampaignId}
            campaignAnalytics={campaignAnalytics}
            campaignContributors={campaignContributors}
            campaignBackers={campaignBackers}
            campaignContributions={campaignContributions}
            analyticsLoading={analyticsLoading}
            contributionsLoading={contributionsLoading}
            onSelectCampaign={loadCampaignAnalytics}
            onThankYou={setIndividualThankYouContribution}
          />
        </section>
      )}

      {activeTab === 'referrals' && isCreator && <ReferralsPanel campaigns={campaigns} />}

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

      <ThankYouToast message={thankYouSent} onDismiss={() => setThankYouSent('')} />

      {bulkThankYouCampaignId && (
        <ThankYouModal
          campaignId={bulkThankYouCampaignId}
          onClose={() => setBulkThankYouCampaignId(null)}
          onSent={() => setThankYouSent(t('thankYou.sent'))}
        />
      )}

      {individualThankYouContribution && (
        <ThankYouModal
          campaignId={selectedCampaignId}
          contribution={individualThankYouContribution}
          onClose={() => setIndividualThankYouContribution(null)}
          onSent={() => setThankYouSent(t('thankYou.sent'))}
        />
      )}
    </main>
  );
}
