import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import CampaignCard from '../components/CampaignCard';

const HERO_IMAGES = [
  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=600&q=70',
  'https://images.unsplash.com/photo-1594708767771-a7502209ff51?auto=format&fit=crop&w=600&q=70',
  'https://images.unsplash.com/photo-1497215728101-856f4ea42174?auto=format&fit=crop&w=600&q=70',
  'https://images.unsplash.com/photo-1518495973542-4542c06a5843?auto=format&fit=crop&w=600&q=70',
];

const SIDEBAR_NAV = [
  {
    to: '/',
    labelKey: 'landing.sidebar_home',
    active: true,
    icon: (
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5z" />
    ),
  },
  {
    to: '/discover',
    labelKey: 'landing.sidebar_discover',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" /></>,
  },
  {
    to: '/discover',
    labelKey: 'landing.sidebar_following',
    icon: <path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />,
  },
  {
    to: '/dashboard',
    labelKey: 'landing.sidebar_my_support',
    icon: <><path d="M4 4h16v12H4z" /><path d="M4 20h16" /></>,
  },
  {
    to: '/discover',
    labelKey: 'landing.sidebar_updates',
    icon: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  },
  {
    to: '/discover',
    labelKey: 'landing.sidebar_messages',
    icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  },
];

const SHORTCUTS = [
  { key: 'education', label: 'Education', to: '/discover?category=education', color: '#2563eb' },
  { key: 'community', label: 'Community', to: '/discover?category=community', color: '#15803d' },
  { key: 'health', label: 'Health', to: '/discover?category=health', color: '#dc2626' },
  { key: 'environment', label: 'Environment', to: '/discover?category=environment', color: '#047857' },
  { key: 'technology', label: 'Technology', to: '/discover?category=technology', color: '#6d28d9' },
];

const TRUST_FEATURES = [
  {
    titleKey: 'landing.trust_first',
    bodyKey: 'landing.trust_first_body',
    bg: 'var(--color-accent-lightest)',
    stroke: 'var(--color-accent)',
    icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  },
  {
    titleKey: 'landing.trust_people',
    bodyKey: 'landing.trust_people_body',
    bg: 'var(--color-success-bg)',
    stroke: '#10b981',
    icon: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  },
  {
    titleKey: 'landing.trust_impact',
    bodyKey: 'landing.trust_impact_body',
    bg: 'var(--color-warning-bg)',
    stroke: '#f59e0b',
    icon: <path d="M3 17l6-6 4 4 8-8" />,
  },
  {
    titleKey: 'landing.trust_secure',
    bodyKey: 'landing.trust_secure_body',
    bg: 'var(--color-accent-lighter)',
    stroke: 'var(--color-accent-dark)',
    icon: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  },
];

const STATS = [
  { value: '$24.8M+', labelKey: 'landing.stats_raised', color: '#2563eb', bg: '#eef3fe' },
  { value: '12,540+', labelKey: 'landing.stats_campaigns', color: '#10b981', bg: '#ecfdf5' },
  { value: '248K+', labelKey: 'landing.stats_donors', color: '#f59e0b', bg: '#fffbeb' },
  { value: '98.6%', labelKey: 'landing.stats_countries', color: '#8b5cf6', bg: '#f5f3ff' },
];

const TABS = [
  'landing.campaigns_tab_recommended',
  'landing.campaigns_tab_trending',
  'landing.campaigns_tab_new',
  'landing.campaigns_tab_ending',
];

function Icon({ children, size = 20, stroke = 'currentColor', width = 2 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const ACTIVITY = [
  { type: 'supported', nameKey: 'Sarah Johnson', target: 'Build a School in Rural Nepal', meta: '$50 · 2m ago', color: '#2563eb' },
  { type: 'update', target: 'Clean Water for Beni Village', meta: '10m ago', color: '#10b981' },
  { type: 'milestone', target: 'Community Health Initiative', meta: '1h ago', color: '#8b5cf6' },
  { type: 'follow', nameKey: 'David Lee', target: 'Tech Education for All', meta: '2h ago', color: '#0ea5e9' },
  { type: 'supporter', target: 'Reforestation Project', meta: '3h ago', color: '#14b8a6' },
];

export default function Landing() {
  const { t } = useTranslation();
  const { user, ready } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    api
      .getFeaturedCampaigns()
      .then((rows) => {
        if (rows.length > 0) {
          setCampaigns(rows.slice(0, 4));
          return;
        }
        api
          .getCampaigns({ limit: 4, sort: 'trending', status: 'active' })
          .then((data) => {
            setCampaigns(data.campaigns || []);
          })
          .catch(() => {});
      })
      .catch(() => {});
  }, []);

  if (ready && user) return <Navigate to="/discover" replace />;

  return (
    <main style={{ background: 'var(--color-surface)', minHeight: '100vh' }}>
      <div className="app-shell">
        {/* ---------------- Sidebar ---------------- */}
        <aside className="app-shell__sidebar">
          <nav className="side-nav" aria-label="Primary">
            {SIDEBAR_NAV.map((item) => (
              <Link
                key={item.labelKey}
                to={item.to}
                className={`side-nav__item${item.active ? ' side-nav__item--active' : ''}`}
              >
                <Icon size={18} width={1.8}>{item.icon}</Icon>
                {t(item.labelKey)}
              </Link>
            ))}

            <div className="side-nav__label">{t('landing.sidebar_shortcuts')}</div>
            {SHORTCUTS.map((s) => (
              <Link key={s.key} to={s.to} className="side-nav__item">
                <span
                  aria-hidden="true"
                  style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }}
                />
                {s.label}
              </Link>
            ))}
            <Link to="/discover" className="side-nav__item" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
              <Icon size={18} width={1.8}><><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></></Icon>
              {t('landing.sidebar_view_all_categories')}
            </Link>
          </nav>

          <div className="trust-callout">
            <div
              style={{
                width: 48, height: 48, borderRadius: 12, margin: '0 auto 0.85rem',
                background: 'var(--color-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Icon size={24} stroke="#fff"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></Icon>
            </div>
            <strong style={{ display: 'block', fontSize: '0.95rem', color: 'var(--color-text-primary)', marginBottom: '0.4rem' }}>
              {t('landing.sidebar_trust_title')}
            </strong>
            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
              {t('landing.sidebar_trust_body')}
            </p>
            <Link to="/how-it-works" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-accent)' }}>
              {t('landing.sidebar_trust_link')} →
            </Link>
          </div>
        </aside>

        {/* ---------------- Main column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
          {/* Hero */}
          <section style={styles.hero}>
            <div style={styles.heroText}>
              <span className="eyebrow" style={styles.heroEyebrow}>{t('landing.hero_eyebrow')}</span>
              <h1 style={styles.h1}>
                {t('landing.hero_title').split('\n').map((line, i) => (
                  <span key={i} style={{ display: 'block', color: i === 1 ? 'var(--color-accent)' : 'inherit' }}>
                    {line}
                  </span>
                ))}
              </h1>
              <p style={styles.sub}>{t('landing.hero_subtitle')}</p>
              <div style={styles.heroActions}>
                <Link to="/discover">
                  <button type="button" className="btn-accent" style={styles.ctaBtn}>
                    {t('landing.hero_cta_start')}
                  </button>
                </Link>
                <Link to="/how-it-works">
                  <button type="button" className="btn-secondary" style={styles.ctaBtn}>
                    <Icon size={18}><circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" /></Icon>
                    <span style={{ marginLeft: '0.5rem' }}>{t('landing.hero_cta_explore')}</span>
                  </button>
                </Link>
              </div>
            </div>

            <div style={styles.heroVisual}>
              <div className="hero-collage">
                {HERO_IMAGES.map((src, i) => (
                  <img key={i} src={src} alt="" loading="lazy" />
                ))}
              </div>

              {/* Verified badge card */}
              <div style={styles.verifiedCard}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                  <span style={styles.verifiedCheck}>
                    <Icon size={13} stroke="#fff" width={3}><polyline points="20 6 9 17 4 12" /></Icon>
                  </span>
                  <strong style={{ fontSize: '0.85rem' }}>{t('landing.hero_verified_title')}</strong>
                </div>
                <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.4, marginBottom: '0.4rem' }}>
                  {t('landing.hero_verified_body')}
                </p>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#7ba3f5' }}>{t('landing.hero_learn_more')} →</span>
              </div>

              {/* Milestone card */}
              <div style={styles.milestoneCard}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
                  <span style={{ color: '#34d399', fontSize: '0.72rem', fontWeight: 700 }}>{t('landing.hero_milestone')}</span>
                  <Icon size={13} stroke="#34d399" width={3}><polyline points="20 6 9 17 4 12" /></Icon>
                </div>
                <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{t('landing.hero_milestone_body')}</div>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.6)', marginTop: '0.2rem' }}>{t('landing.hero_milestone_date')}</div>
              </div>
            </div>
          </section>

          {/* Feature strip */}
          <div className="feature-strip">
            {TRUST_FEATURES.map((f) => (
              <div key={f.titleKey} style={{ display: 'flex', gap: '0.85rem', alignItems: 'flex-start' }}>
                <span style={{ ...styles.featureIcon, background: f.bg }}>
                  <Icon size={22} stroke={f.stroke}>{f.icon}</Icon>
                </span>
                <div>
                  <strong style={{ display: 'block', fontSize: '0.9rem', color: 'var(--color-text-primary)', marginBottom: '0.2rem' }}>
                    {t(f.titleKey)}
                  </strong>
                  <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                    {t(f.bodyKey)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Featured Support Spaces */}
          {campaigns.length > 0 && (
            <section>
              <div style={styles.spacesHeader}>
                <h2 style={styles.spacesTitle}>{t('landing.campaigns_title')}</h2>
                <Link to="/discover" style={styles.viewAllLink}>
                  {t('landing.campaigns_view_all')}
                  <Icon size={16}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></Icon>
                </Link>
              </div>
              <div style={styles.tabsRow}>
                {TABS.map((tab, i) => (
                  <button
                    key={tab}
                    type="button"
                    className={`space-tab${activeTab === i ? ' space-tab--active' : ''}`}
                    onClick={() => setActiveTab(i)}
                  >
                    {t(tab)}
                  </button>
                ))}
              </div>
              <div className="spaces-grid">
                {campaigns.map((c) => (
                  <CampaignCard key={c.id} campaign={c} featured />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ---------------- Right rail ---------------- */}
        <aside className="app-shell__rail">
          {/* Recent Activity */}
          <div style={styles.railCard}>
            <div style={styles.railHeader}>
              <strong style={styles.railTitle}>{t('landing.activity_title')}</strong>
              <Link to="/discover" style={styles.railLink}>{t('landing.activity_view_all')}</Link>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {ACTIVITY.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start' }}>
                  <span aria-hidden="true" style={{ ...styles.activityDot, background: a.color }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
                      {a.type === 'supported' && <>{t('landing.activity_supported', { name: a.nameKey })} <strong style={styles.activityStrong}>{a.target}</strong></>}
                      {a.type === 'update' && <>{t('landing.activity_update_posted')} <strong style={styles.activityStrong}>{a.target}</strong></>}
                      {a.type === 'milestone' && <>{t('landing.activity_milestone')} <strong style={styles.activityStrong}>{a.target}</strong></>}
                      {a.type === 'follow' && <>{t('landing.activity_started_following', { name: a.nameKey })} <strong style={styles.activityStrong}>{a.target}</strong></>}
                      {a.type === 'supporter' && <>{t('landing.activity_new_supporter')} <strong style={styles.activityStrong}>{a.target}</strong></>}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-hint)', marginTop: '0.15rem' }}>{a.meta}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CrowdPay in Numbers */}
          <div style={styles.railCard}>
            <strong style={{ ...styles.railTitle, display: 'block', marginBottom: '1rem' }}>{t('landing.stats_title')}</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              {STATS.map((s) => (
                <div key={s.labelKey}>
                  <span style={{ ...styles.numberIcon, background: s.bg, color: s.color }}>
                    <Icon size={16} stroke={s.color}><path d="M20 6L9 17l-5-5" /></Icon>
                  </span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>{s.value}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--color-text-hint)' }}>{t(s.labelKey)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Newsletter */}
          <div style={{ ...styles.railCard, background: 'var(--color-accent-lightest)', borderColor: 'var(--color-accent-lighter)' }}>
            <span style={{ ...styles.numberIcon, background: 'var(--color-accent)', color: '#fff', marginBottom: '0.85rem' }}>
              <Icon size={18} stroke="#fff"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></Icon>
            </span>
            <strong style={{ display: 'block', fontSize: '1rem', color: 'var(--color-text-primary)', marginBottom: '0.4rem', lineHeight: 1.3 }}>
              {t('landing.newsletter_title')}
            </strong>
            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: '0.85rem' }}>
              {t('landing.newsletter_body')}
            </p>
            <form onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="email"
                placeholder={t('landing.newsletter_placeholder')}
                aria-label={t('landing.newsletter_placeholder')}
                style={{ background: 'var(--color-bg)', fontSize: '0.82rem' }}
              />
              <button type="submit" className="btn-accent" style={{ padding: '0.5rem 1rem', fontSize: '0.82rem', flexShrink: 0 }}>
                {t('landing.newsletter_subscribe')}
              </button>
            </form>
          </div>
        </aside>
      </div>
    </main>
  );
}

const styles = {
  hero: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '18px',
    padding: '2.25rem',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: '2rem',
    alignItems: 'center',
  },
  heroText: { minWidth: 0 },
  heroEyebrow: {
    background: 'var(--color-accent-lightest)',
    padding: '4px 12px',
    borderRadius: '99px',
    marginBottom: '1.25rem',
    letterSpacing: '0.04em',
  },
  h1: {
    fontSize: 'clamp(1.9rem, 3.4vw, 2.75rem)',
    fontWeight: 900,
    letterSpacing: '-0.03em',
    lineHeight: 1.08,
    marginBottom: '1.1rem',
    color: 'var(--color-text-primary)',
  },
  sub: {
    fontSize: '0.98rem',
    color: 'var(--color-text-secondary)',
    marginBottom: '1.75rem',
    lineHeight: 1.6,
  },
  heroActions: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap' },
  ctaBtn: {
    fontSize: '0.9rem',
    padding: '0.75rem 1.4rem',
    display: 'inline-flex',
    alignItems: 'center',
  },
  heroVisual: { position: 'relative', minWidth: 0 },
  verifiedCard: {
    position: 'absolute',
    top: '-14px',
    right: '-14px',
    width: '210px',
    background: '#0b1220',
    color: '#fff',
    borderRadius: '14px',
    padding: '0.85rem 1rem',
    boxShadow: '0 12px 30px rgba(11,15,25,0.25)',
  },
  verifiedCheck: {
    width: 20, height: 20, borderRadius: '50%', background: '#10b981',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  milestoneCard: {
    position: 'absolute',
    bottom: '-16px',
    left: '10%',
    background: '#0b1220',
    color: '#fff',
    borderRadius: '12px',
    padding: '0.7rem 0.9rem',
    boxShadow: '0 12px 30px rgba(11,15,25,0.25)',
    maxWidth: '210px',
  },
  featureIcon: {
    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  spacesHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem',
  },
  spacesTitle: {
    fontSize: '1.3rem', fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em',
  },
  viewAllLink: {
    display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
    fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-accent)',
  },
  tabsRow: {
    display: 'flex', gap: '1.5rem', borderBottom: '1px solid var(--color-border-light)', marginBottom: '1.25rem',
  },
  railCard: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '16px',
    padding: '1.25rem',
  },
  railHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem',
  },
  railTitle: { fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-text-primary)' },
  railLink: { fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-accent)' },
  activityDot: { width: 8, height: 8, borderRadius: '50%', marginTop: '5px', flexShrink: 0 },
  activityStrong: { color: 'var(--color-text-primary)', fontWeight: 600 },
  numberIcon: {
    width: 34, height: 34, borderRadius: 9, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', marginBottom: '0.5rem',
  },
};
