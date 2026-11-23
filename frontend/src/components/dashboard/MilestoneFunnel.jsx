import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

export default function MilestoneFunnel({ campaignId }) {
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
