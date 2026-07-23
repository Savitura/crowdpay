import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

export default function Pricing() {
  const [feeBps, setFeeBps] = useState(null);

  useEffect(() => {
    api
      .getPlatformConfig()
      .then((cfg) => setFeeBps(cfg.platform_fee_bps ?? 0))
      .catch(() => setFeeBps(0));
  }, []);

  return (
    <main className="container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}>
      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.75rem' }}>Pricing</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: '2rem', lineHeight: 1.6 }}>
        Creating an account and starting a campaign is free. CrowdPay takes a small platform fee only
        on funds that are actually raised.
      </p>

      <div className="campaign-card" style={{ minHeight: 'auto', marginBottom: '1.5rem' }}>
        <strong style={{ fontSize: '1.1rem' }}>Platform fee</strong>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
          {feeBps === null
            ? 'Loading current rate…'
            : `${(feeBps / 100).toFixed(2)}% of each contribution, deducted automatically before funds reach the campaign.`}
        </p>
      </div>

      <div style={{ display: 'grid', gap: '1rem' }}>
        <div>
          <strong style={{ fontSize: '0.95rem' }}>No listing fees</strong>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.88rem', marginTop: '0.25rem' }}>
            Publishing a campaign costs nothing, whether or not it reaches its goal.
          </p>
        </div>
        <div>
          <strong style={{ fontSize: '0.95rem' }}>Payment processing is included</strong>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.88rem', marginTop: '0.25rem' }}>
            Bank, card, and wallet payment routing are covered by the platform fee — there&apos;s no separate
            processor charge.
          </p>
        </div>
      </div>

      <div style={{ marginTop: '2.5rem' }}>
        <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          Start a campaign →
        </Link>
      </div>
    </main>
  );
}
