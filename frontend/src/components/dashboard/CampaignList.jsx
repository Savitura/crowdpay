import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import CampaignStatusBadge from '../CampaignStatusBadge';
import ActionCenter from './ActionCenter';
import { progressPct } from '../../lib/dashboardHelpers';

export default function CampaignList({
  campaigns,
  loading,
  isCreator,
  isCampaignsPageLoading,
  campaignsPage,
  campaignsTotalPages,
  campaignsTotal,
  setCampaignsPage,
  exportingCampaignId,
  togglingVisibility,
  onExportContributions,
  onToggleVisibility,
  onBulkThankYou,
}) {
  const { t } = useTranslation();

  return (
    <>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          {t('dashboard.createNewCampaign')}
        </Link>
      </div>

      {campaigns.length > 0 && <ActionCenter campaigns={campaigns} />}

      {campaigns.length === 0 ? (
        <p className="alert alert--info">{t('dashboard.noCampaigns')}</p>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gap: '0.75rem',
              opacity: isCampaignsPageLoading ? 0.5 : 1,
              transition: 'opacity 0.2s',
            }}
          >
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
                          {t('dashboard.hidden')}
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
                    {t('dashboard.contributorsCount', {
                      count: campaign.contributor_count,
                    })}
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
                    <Link
                      to={`/campaigns/${campaign.id}/share`}
                      style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                    >
                      Share
                    </Link>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={exportingCampaignId !== null}
                      aria-busy={exportingCampaignId === campaign.id}
                      onClick={() => onExportContributions(campaign)}
                      style={{ fontSize: '0.82rem', padding: '0.3rem 0.8rem' }}
                    >
                      {exportingCampaignId === campaign.id
                        ? t('common.loading')
                        : t('dashboard.exportCsv')}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => onBulkThankYou(campaign.id)}
                      style={{ fontSize: '0.82rem', padding: '0.3rem 0.8rem' }}
                    >
                      {t('dashboard.sendThankYou')}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={togglingVisibility !== null}
                      aria-busy={togglingVisibility === campaign.id}
                      onClick={() => onToggleVisibility(campaign)}
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
          {campaignsTotalPages > 1 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '1.5rem',
                flexWrap: 'wrap',
                gap: '1rem',
              }}
            >
              <span style={{ fontSize: '0.9rem', color: 'var(--color-text-hint)' }}>
                {t('dashboard.showingCampaignsOf', {
                  count: campaigns.length,
                  total: campaignsTotal,
                })}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={campaignsPage === 1 || isCampaignsPageLoading}
                  onClick={() => setCampaignsPage((p) => Math.max(1, p - 1))}
                  style={{ padding: '0.3rem 0.8rem', fontSize: '0.85rem' }}
                >
                  {t('dashboard.previous')}
                </button>
                <span style={{ fontSize: '0.9rem' }}>
                  {t('dashboard.pageOf', {
                    page: campaignsPage,
                    totalPages: campaignsTotalPages,
                  })}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={campaignsPage === campaignsTotalPages || isCampaignsPageLoading}
                  onClick={() => setCampaignsPage((p) => Math.min(campaignsTotalPages, p + 1))}
                  style={{ padding: '0.3rem 0.8rem', fontSize: '0.85rem' }}
                >
                  {t('dashboard.next')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
