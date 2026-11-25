import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { badgeStyle } from '../components/admin/AdminShared';

const PlatformHealthPanel = lazy(() => import('../components/admin/PlatformHealthPanel'));
const WithdrawalQueue = lazy(() => import('../components/admin/WithdrawalQueue'));
const DisputeManagement = lazy(() => import('../components/admin/DisputeManagement'));
const KycOversight = lazy(() => import('../components/admin/KycOversight'));
const CampaignsQueue = lazy(() => import('../components/admin/CampaignsQueue'));
const MilestonesQueue = lazy(() => import('../components/admin/MilestonesQueue'));
const FraudQueue = lazy(() => import('../components/admin/FraudQueue'));
const AuditLogViewer = lazy(() => import('../components/admin/AuditLogViewer'));

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'withdrawals', label: 'Withdrawals' },
  { id: 'disputes', label: 'Disputes' },
  { id: 'kyc', label: 'KYC' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'fraud', label: 'Fraud Detection' },
  { id: 'audit', label: 'Audit Log' },
];

const panelFallback = <p style={{ color: 'var(--color-text-hint)' }}>Loading admin panel…</p>;

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (!user || (user.role !== 'admin' && !user.is_admin)) {
      navigate('/discover');
    }
  }, [user, navigate]);

  return (
    <div style={{ maxWidth: '960px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Admin Dashboard</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Withdrawal approvals, dispute management, KYC oversight, and platform health.
      </p>

      <nav
        role="tablist"
        style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...badgeStyle,
              cursor: 'pointer',
              background: tab === t.id ? 'var(--color-accent)' : 'var(--color-accent-soft)',
              color: tab === t.id ? 'var(--color-bg)' : 'var(--color-accent)',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <Suspense fallback={panelFallback}>
          <PlatformHealthPanel />
        </Suspense>
      )}
      {tab === 'withdrawals' && (
        <Suspense fallback={panelFallback}>
          <WithdrawalQueue />
        </Suspense>
      )}
      {tab === 'disputes' && (
        <Suspense fallback={panelFallback}>
          <DisputeManagement />
        </Suspense>
      )}
      {tab === 'kyc' && (
        <Suspense fallback={panelFallback}>
          <KycOversight />
        </Suspense>
      )}
      {tab === 'campaigns' && (
        <Suspense fallback={panelFallback}>
          <CampaignsQueue />
        </Suspense>
      )}
      {tab === 'milestones' && (
        <Suspense fallback={panelFallback}>
          <MilestonesQueue />
        </Suspense>
      )}
      {tab === 'fraud' && (
        <Suspense fallback={panelFallback}>
          <FraudQueue />
        </Suspense>
      )}
      {tab === 'audit' && (
        <Suspense fallback={panelFallback}>
          <AuditLogViewer />
        </Suspense>
      )}
    </div>
  );
}
