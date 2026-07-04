import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import CampaignCard from '../components/CampaignCard';

const PLACEHOLDER_STATS = [
  { icon: '💳', value: '$4.2M+', label: 'Total raised' },
  { icon: '🤝', value: '13,482+', label: 'Total donors' },
  { icon: '📣', value: '1,242+', label: 'Active campaigns' },
  { icon: '🌍', value: '41+', label: 'Countries supported' },
];

export default function Landing() {
  const { t } = useTranslation();
  const { user, ready } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [spotlight, setSpotlight] = useState(null);

  useEffect(() => {
    api
      .getFeaturedCampaigns()
      .then((rows) => {
        if (rows.length > 0) {
          setCampaigns(rows.slice(0, 4));
          setSpotlight(rows[0]);
          return;
        }
        api
          .getCampaigns({ limit: 4, sort: 'trending', status: 'active' })
          .then((data) => {
            const rows2 = data.campaigns || [];
            setCampaigns(rows2);
            setSpotlight(rows2[0] || null);
          })
          .catch(() => {});
      })
      .catch(() => {});
  }, []);

  if (ready && user) return <Navigate to="/discover" replace />;

  return (
    <main>
      <section style={styles.hero}>
        <div className="container" style={styles.heroInner}>
          <div style={styles.heroText}>
            <span style={styles.eyebrow}>Fundraising without borders</span>
            <h1 style={styles.h1}>{t('landing.hero_title')}</h1>
            <p style={styles.sub}>{t('landing.hero_subtitle')}</p>
            <div style={styles.heroActions}>
              <Link to="/register">
                <button type="button" className="btn-primary" style={styles.ctaBtn}>
                  {t('common.createAccount')}
                </button>
              </Link>
              <Link to="/discover">
                <button type="button" className="btn-secondary" style={styles.ctaBtn}>
                  {t('landing.cta_explore')}
                </button>
              </Link>
            </div>
            <p style={styles.proofLine}>Join 13,482+ people building campaigns worldwide.</p>
          </div>

          {spotlight && (
            <div style={styles.spotlightWrap}>
              <CampaignCard campaign={spotlight} featured />
            </div>
          )}
        </div>
      </section>

      <section style={styles.section}>
        <div className="container">
          <div style={styles.statsGrid}>
            {PLACEHOLDER_STATS.map((s) => (
              <div key={s.label} style={styles.statCard}>
                <div style={styles.statIcon} aria-hidden="true">{s.icon}</div>
                <strong style={styles.statValue}>{s.value}</strong>
                <div style={styles.statLabel}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {campaigns.length > 0 && (
        <section style={styles.section}>
          <div className="container">
            <span style={styles.sectionEyebrow}>Featured campaigns</span>
            <h2 style={styles.sectionTitle}>{t('landing.campaigns_title', 'Real stories. Real impact.')}</h2>
            <div style={styles.campaignGrid}>
              {campaigns.map((c) => (
                <CampaignCard key={c.id} campaign={c} featured />
              ))}
            </div>
          </div>
        </section>
      )}

      <section style={styles.section}>
        <div className="container">
          <h2 style={styles.sectionTitle}>{t('landing.trust_title')}</h2>
          <div style={styles.trustGrid}>
            <div style={styles.trustCard}>
              <strong style={styles.trustCardTitle}>{t('landing.trust_verified')}</strong>
              <p style={styles.trustBody}>{t('landing.trust_verified_body')}</p>
            </div>
            <div style={styles.trustCard}>
              <strong style={styles.trustCardTitle}>{t('landing.trust_transparent')}</strong>
              <p style={styles.trustBody}>{t('landing.trust_transparent_body')}</p>
            </div>
            <div style={styles.trustCard}>
              <strong style={styles.trustCardTitle}>{t('landing.trust_global')}</strong>
              <p style={styles.trustBody}>{t('landing.trust_global_body')}</p>
            </div>
          </div>
        </div>
      </section>

      <section style={{ ...styles.section, paddingBottom: '4rem' }}>
        <div className="container" style={styles.closingCta}>
          <h2 style={styles.closingTitle}>{t('landing.cta_title')}</h2>
          <Link to="/register">
            <button type="button" className="btn-primary" style={styles.ctaBtn}>
              {t('landing.cta_start')}
            </button>
          </Link>
        </div>
      </section>
    </main>
  );
}

const styles = {
  hero: { background: 'var(--color-accent-lightest)', borderBottom: '1px solid var(--color-border-light)' },
  heroInner: {
    padding: '3.5rem 1.25rem',
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 1fr) minmax(260px, 380px)',
    gap: '2.5rem',
    alignItems: 'center',
  },
  heroText: { maxWidth: '520px' },
  eyebrow: {
    display: 'inline-block',
    fontSize: '0.78rem',
    fontWeight: 700,
    color: 'var(--color-accent)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginBottom: '0.9rem',
  },
  h1: {
    fontSize: 'clamp(1.9rem, 4.5vw, 2.75rem)',
    fontWeight: 800,
    letterSpacing: '-0.02em',
    lineHeight: 1.15,
    marginBottom: '0.9rem',
    color: 'var(--color-text-primary)',
  },
  sub: {
    fontSize: '0.98rem',
    color: 'var(--color-text-secondary)',
    marginBottom: '1.5rem',
    lineHeight: 1.6,
  },
  heroActions: { display: 'flex', gap: '0.65rem', flexWrap: 'wrap', marginBottom: '1.1rem' },
  ctaBtn: { fontSize: '0.9rem', padding: '0.75rem 1.4rem' },
  proofLine: { fontSize: '0.85rem', color: 'var(--color-text-hint)' },
  spotlightWrap: { minWidth: 0 },
  section: { padding: '2.75rem 0' },
  sectionEyebrow: {
    display: 'block',
    fontSize: '0.78rem',
    fontWeight: 700,
    color: 'var(--color-accent)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginBottom: '0.4rem',
  },
  sectionTitle: {
    fontSize: '1.3rem',
    fontWeight: 700,
    marginBottom: '1.25rem',
    color: 'var(--color-text-primary)',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '1rem',
  },
  statCard: {
    textAlign: 'center',
    background: 'var(--color-surface)',
    borderRadius: '10px',
    padding: '1.25rem 1rem',
  },
  statIcon: { fontSize: '1.4rem', marginBottom: '0.5rem' },
  statValue: { fontSize: '1.4rem', fontWeight: 800, color: 'var(--color-text-primary)', display: 'block' },
  statLabel: { fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginTop: '0.2rem' },
  campaignGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))',
    gap: '1.25rem',
  },
  trustGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '1.25rem',
  },
  trustCard: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.1rem 1.25rem',
  },
  trustCardTitle: { fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-text-primary)' },
  trustBody: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.85rem',
    marginTop: '0.4rem',
    lineHeight: 1.55,
  },
  closingCta: { textAlign: 'center', padding: '1rem 1.25rem 0' },
  closingTitle: {
    fontSize: '1.4rem',
    fontWeight: 700,
    marginBottom: '1.25rem',
    color: 'var(--color-text-primary)',
  },
};
