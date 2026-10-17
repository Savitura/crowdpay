import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import CampaignCard from '../components/CampaignCard';

function Icon({ children }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const TRUST_STEPS = [
  {
    number: '01',
    titleKey: 'landing.trust_verified',
    bodyKey: 'landing.trust_verified_body',
    icon: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
  {
    number: '02',
    titleKey: 'landing.trust_protected',
    bodyKey: 'landing.trust_protected_body',
    icon: (
      <>
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>
    ),
  },
  {
    number: '03',
    titleKey: 'landing.trust_milestones',
    bodyKey: 'landing.trust_milestones_body',
    icon: (
      <>
        <path d="M4 19V5" />
        <path d="m4 14 5-5 4 4 7-7" />
        <path d="M16 6h4v4" />
      </>
    ),
  },
];

export default function Landing() {
  const { t } = useTranslation();
  const { user, ready } = useAuth();
  const [campaigns, setCampaigns] = useState([]);

  useEffect(() => {
    api
      .getFeaturedCampaigns()
      .then((rows) => {
        if (rows.length > 0) {
          setCampaigns(rows.slice(0, 3));
          return null;
        }
        return api.getCampaigns({ limit: 3, sort: 'trending', status: 'active' }).then((data) => {
          setCampaigns((data.campaigns || []).slice(0, 3));
        });
      })
      .catch(() => {});
  }, []);

  if (ready && user) return <Navigate to="/discover" replace />;

  return (
    <main className="landing-simple">
      <section className="landing-hero" aria-labelledby="landing-title">
        <span className="eyebrow">{t('landing.hero_eyebrow')}</span>
        <h1 id="landing-title">{t('landing.hero_title_compact')}</h1>
        <p>{t('landing.hero_subtitle')}</p>
        <div className="landing-hero__actions">
          <Link to="/discover" className="btn-accent landing-cta">
            {t('landing.hero_cta_start')}
          </Link>
          <Link to="/register?role=creator" className="btn-secondary landing-cta">
            {t('landing.cta_start')}
          </Link>
        </div>
        <p className="landing-hero__note">{t('landing.hero_note')}</p>
      </section>

      <section className="landing-section" aria-labelledby="trust-title">
        <div className="landing-section__heading">
          <span className="eyebrow">{t('landing.trust_eyebrow')}</span>
          <h2 id="trust-title">{t('landing.trust_title')}</h2>
          <p>{t('landing.trust_intro')}</p>
        </div>
        <div className="landing-trust-grid">
          {TRUST_STEPS.map((step) => (
            <article className="landing-trust-card" key={step.number}>
              <div className="landing-trust-card__top">
                <span className="landing-trust-card__icon">
                  <Icon>{step.icon}</Icon>
                </span>
                <span className="landing-trust-card__number">{step.number}</span>
              </div>
              <h3>{t(step.titleKey)}</h3>
              <p>{t(step.bodyKey)}</p>
            </article>
          ))}
        </div>
      </section>

      {campaigns.length > 0 && (
        <section className="landing-section" aria-labelledby="featured-title">
          <div className="landing-section__heading landing-section__heading--row">
            <div>
              <span className="eyebrow">{t('landing.campaigns_eyebrow')}</span>
              <h2 id="featured-title">{t('landing.campaigns_title')}</h2>
            </div>
            <Link to="/discover" className="landing-text-link">
              {t('landing.campaigns_view_all')} →
            </Link>
          </div>
          <div className="landing-campaign-grid">
            {campaigns.map((campaign) => (
              <CampaignCard key={campaign.id} campaign={campaign} featured />
            ))}
          </div>
        </section>
      )}

      <section className="landing-creator" aria-labelledby="creator-title">
        <div>
          <span className="eyebrow">{t('landing.creator_eyebrow')}</span>
          <h2 id="creator-title">{t('landing.creator_title')}</h2>
          <p>{t('landing.creator_body')}</p>
        </div>
        <div className="landing-creator__action">
          <Link to="/register?role=creator" className="btn-accent landing-cta">
            {t('landing.cta_start')}
          </Link>
          <Link to="/how-it-works" className="landing-text-link">
            {t('landing.creator_learn')} →
          </Link>
        </div>
      </section>

      <aside className="landing-testnet" aria-label={t('landing.testnet_title')}>
        <span className="landing-testnet__dot" aria-hidden="true" />
        <div>
          <strong>{t('landing.testnet_title')}</strong>
          <p>{t('landing.testnet_body')}</p>
        </div>
      </aside>
    </main>
  );
}
