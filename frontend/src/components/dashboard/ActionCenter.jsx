import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { buildActionItems } from '../../lib/dashboardHelpers';

export default function ActionCenter({ campaigns }) {
  const [milestonesByCampaign, setMilestonesByCampaign] = useState({});
  const [lastUpdateByCampaign, setLastUpdateByCampaign] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const activeCampaigns = campaigns.filter((c) => c.status === 'active');
    if (activeCampaigns.length === 0) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    Promise.all(
      activeCampaigns.map((c) =>
        Promise.all([
          api.getMilestones(c.id).catch(() => []),
          api.getCampaignUpdates(c.id, { limit: 1 }).catch(() => null),
        ]).then(([milestones, updatesRes]) => [c.id, milestones, updatesRes])
      )
    ).then((results) => {
      if (cancelled) return;
      const milestoneMap = {};
      const updateMap = {};
      results.forEach(([id, milestones, updatesRes]) => {
        milestoneMap[id] = milestones || [];
        const updates = Array.isArray(updatesRes) ? updatesRes : updatesRes?.updates;
        if (updates && updates.length > 0) updateMap[id] = updates[0];
      });
      setMilestonesByCampaign(milestoneMap);
      setLastUpdateByCampaign(updateMap);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [campaigns]);

  if (!loaded) return null;

  const items = buildActionItems(campaigns, milestonesByCampaign, lastUpdateByCampaign);
  if (items.length === 0) return null;

  return (
    <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
      <strong style={{ fontSize: '1rem' }}>What needs your attention</strong>
      <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.75rem' }}>
        {items.map((item) => (
          <Link
            key={item.key}
            to={`/campaigns/${item.campaignId}`}
            style={{
              display: 'block',
              padding: '0.65rem 0.85rem',
              borderRadius: '8px',
              border: '1px solid var(--color-border-lighter)',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{item.title}</div>
            <div
              style={{
                fontSize: '0.82rem',
                color: 'var(--color-text-secondary)',
                marginTop: '0.15rem',
              }}
            >
              {item.detail}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
