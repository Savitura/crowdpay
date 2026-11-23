import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';
import CampaignStatusBadge from '../CampaignStatusBadge';

export default function ReferralsPanel({ campaigns }) {
  const { t } = useTranslation();
  const [referralData, setReferralData] = useState({});
  const [referralLoading, setReferralLoading] = useState(false);

  useEffect(() => {
    if (!campaigns.length) return;
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
  }, [campaigns]);

  return (
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
                          <th style={{ padding: '0.35rem 0.5rem' }}>{t('dashboard.referrer')}</th>
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
  );
}
