import { useTranslation } from 'react-i18next';

export default function CreatorStatsGrid({ stats }) {
  const { t } = useTranslation();

  return (
    <>
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
    </>
  );
}
