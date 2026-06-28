import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import CampaignCard from '../components/CampaignCard';
import CampaignCardSkeleton from '../components/skeletons/CampaignCardSkeleton';
import { useAuth } from '../context/AuthContext';
import OnboardingCallout from '../components/OnboardingCallout';
import {
  isContributorOnboardingVisible,
  dismissContributorOnboarding,
  consumeJustRegistered,
} from '../lib/onboarding';

const STATUS_OPTIONS = ['', 'active', 'funded', 'closed', 'failed'];
const ASSET_OPTIONS = ['', 'USDC', 'XLM'];
const SORT_OPTIONS = [
  { value: 'newest', key: 'home.newest', labelKey: 'home.newest' },
  { value: 'trending', labelKey: 'home.sortTrending' },
  { value: 'most_funded', key: 'home.mostFunded', labelKey: 'home.mostFunded' },
  { value: 'closest_to_goal', key: 'home.closestToGoal', labelKey: 'home.closestToGoal' },
];
const QUICK_SORT_OPTIONS = [
  { value: 'newest', labelKey: 'home.newest' },
  { value: 'trending', labelKey: 'home.sortTrending' },
  { value: 'funded', labelKey: 'home.sortMostFunded' },
];
const SEARCH_DEBOUNCE_MS = 450;

export default function Home() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const paginationRequestRef = useRef(false);
  const [listError, setListError] = useState('');
  const { user } = useAuth();
  const [showContributorTips, setShowContributorTips] = useState(isContributorOnboardingVisible);
  const [welcomeNewUser, setWelcomeNewUser] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(() => searchParams.get('search') || '');
  const [sort, setSort] = useState(() => searchParams.get('sort') || 'newest');
  const [categoryCounts, setCategoryCounts] = useState([]);
  const [featured, setFeatured] = useState([]);

  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || '';
  const asset = searchParams.get('asset') || '';
  const category = searchParams.get('category') || '';
  const minProgress = searchParams.get('min_progress') || '';
  const sort = searchParams.get('sort') || 'newest';
  const limit = Number(searchParams.get('limit') || 20);
  const offset = Number(searchParams.get('offset') || 0);

  useEffect(() => {
    const urlSort = searchParams.get('sort') || 'newest';
    if (urlSort !== sort) {
      setSort(urlSort);
    }
  }, [searchParams]);

  const handleSortChange = (newSort) => {
    setSort(newSort);
    setFilters({ sort: newSort });
  };
  const category = searchParams.get('category') || '';

  const hasActiveFilters =
    Boolean(search.trim()) ||
    Boolean(asset) ||
    Boolean(status) ||
    Boolean(category) ||
    sort !== 'newest';

  useEffect(() => {
    if (consumeJustRegistered()) {
      setWelcomeNewUser(true);
    }
    api
      .getCampaignCategories()
      .then(setCategoryCounts)
      .catch(() => {});
    api
      .getFeaturedCampaigns()
      .then(setFeatured)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput.trim() === search.trim()) return;
      setFilters({ search: searchInput.trim() });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  useEffect(() => {
    setListError('');
    setLoading(true);
    api
      .getCampaigns({ search, status, asset, category, min_progress: minProgress, sort, limit, offset })
      .then((data) => {
        const nextCampaigns = data.campaigns || [];
        const nextTotal = data.total || 0;
        setCampaigns(nextCampaigns);
        setTotal(nextTotal);
        setHasMore(nextCampaigns.length < nextTotal);
        setPage(1);
      })
      .catch((err) => setListError(err.message || t('home.loadingCampaigns')))
      .finally(() => setLoading(false));
  }, [search, status, asset, category, sort]);

  async function loadMore() {
    if (loadingMore || !hasMore || paginationRequestRef.current) return;

    paginationRequestRef.current = true;
    const scrollPosition = window.scrollY;
    setLoadingMore(true);
    setListError('');

    try {
      const { campaigns: next, total: nextTotal } = await api.getCampaigns({
        search,
        status,
        asset,
        category,
        sort,
        limit: 20,
        offset: page * 20,
      });

      setCampaigns((prev) => {
        const updated = [...prev, ...next];
        setHasMore(updated.length < nextTotal);
        return updated;
      });
      setTotal(nextTotal);
      setPage((p) => p + 1);

      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollPosition });
      });
    } catch (err) {
      setListError(err.message || t('home.loadingCampaigns'));
    } finally {
      paginationRequestRef.current = false;
      setLoadingMore(false);
    }
  }

  const setFilters = (next) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(next).forEach(([key, value]) => {
      if (value === '' || value === null) {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    });
    params.delete('offset');
    setSearchParams(params, { replace: true });
  };

  function dismissContributorTips() {
    dismissContributorOnboarding();
    setShowContributorTips(false);
  }

  return (
    <main className="container" style={{ paddingTop: '1.5rem', paddingBottom: '4rem' }}>
      {welcomeNewUser && (
        <div className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
          <strong>{t('home.welcomeTitle')}</strong> {t('home.welcomeBody')}
          <button
            type="button"
            onClick={() => setWelcomeNewUser(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: 'var(--color-success-text)',
              fontWeight: 600,
              textDecoration: 'underline',
              padding: 0,
              minHeight: 'auto',
            }}
          >
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {user && showContributorTips && (
        <OnboardingCallout title={t('home.onboardingTitle')} onDismiss={dismissContributorTips}>
          <ul>
            <li>{t('home.onboardingItem1')}</li>
            <li>{t('home.onboardingItem2')}</li>
            <li>{t('home.onboardingItem3')}</li>
          </ul>
        </OnboardingCallout>
      )}

      <div style={styles.hero}>
        <h1 style={styles.h1}>{t('home.hero_title')}</h1>
        <p style={styles.sub}>{t('home.hero_subtitle')}</p>
        {user ? (
          <div className="hero-actions">
            {(user.role === 'creator' || user.role === 'admin') && (
              <Link to="/campaigns/new" style={{ width: '100%' }}>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}
                >
                  {t('home.startCampaign')}
                </button>
              </Link>
            )}
            <span style={styles.muted}>{t('home.browseHint')}</span>
          </div>
        ) : (
          <div className="hero-actions hero-actions--row-sm">
            <Link to="/register" style={{ flex: '1 1 140px', minWidth: '140px' }}>
              <button
                type="button"
                className="btn-primary"
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}
              >
                {t('home.createAccount')}
              </button>
            </Link>
            <Link to="/login" style={{ flex: '1 1 140px', minWidth: '140px' }}>
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}
              >
                {t('login.title')}
              </button>
            </Link>
          </div>
        )}
      </div>

      {featured.length > 0 && (
        <section style={{ marginBottom: '2.5rem' }}>
          <h2 style={styles.sectionTitle}>{t('home.featuredCampaigns')}</h2>
          <div
            style={{
              ...styles.grid,
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
            }}
          >
            {featured.map((c) => (
              <CampaignCard key={c.id} campaign={c} featured />
            ))}
          </div>
        </section>
      )}

      <div style={styles.filterBar}>
        <label style={styles.filterItem}>
          {t('home.searchLabel')}
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('home.searchPlaceholder')}
            style={styles.filterInput}
            aria-label={t('home.searchLabel')}
          />
        </label>
        <label style={styles.filterItem}>
          {t('home.statusLabel')}
          <select
            value={status}
            onChange={(e) => setFilters({ status: e.target.value })}
            style={styles.filterInput}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === ''
                  ? t('home.anyStatus')
                  : t(`home.status${option[0].toUpperCase()}${option.slice(1)}`)}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.filterItem}>
          {t('home.assetLabel')}
          <select
            value={asset}
            onChange={(e) => setFilters({ asset: e.target.value })}
            style={styles.filterInput}
          >
            {ASSET_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === '' ? t('home.anyAsset') : option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.filterItem}>
          Category
          <input
            value={category}
            onChange={(e) => setFilters({ category: e.target.value })}
            placeholder="e.g. tech, art"
            style={styles.filterInput}
          />
        </label>
        <label style={styles.filterItem}>
          Min Progress (%)
          <input
            type="number"
            min="0"
            max="100"
            value={minProgress}
            onChange={(e) => setFilters({ min_progress: e.target.value })}
            placeholder="e.g. 50"
            style={styles.filterInput}
          />
        </label>
        <label style={styles.filterItem}>
          Sort by
          {t('home.sortLabel')}
          <select
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            style={styles.filterInput}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.key ? t(option.key) : t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(search || status || asset || category || minProgress) && (
        <div style={styles.activeFilters}>
          {search && (
            <button className="filter-chip" onClick={() => setFilters({ search: '' })}>
              Search: {search} ✕
            </button>
          )}
          {status && (
            <button className="filter-chip" onClick={() => setFilters({ status: '' })}>
              Status: {status} ✕
            </button>
          )}
          {asset && (
            <button className="filter-chip" onClick={() => setFilters({ asset: '' })}>
              Asset: {asset} ✕
            </button>
          )}
          {category && (
            <button className="filter-chip" onClick={() => setFilters({ category: '' })}>
              Category: {category} ✕
            </button>
          )}
          {minProgress && (
            <button className="filter-chip" onClick={() => setFilters({ min_progress: '' })}>
              Min Progress: {minProgress}% ✕
            </button>
          )}
        </div>
      )}

      <h2 style={styles.sectionTitle}>Active campaigns</h2>
      <h2 style={styles.sectionTitle}>{t('home.activeCampaigns')}</h2>
      <div style={styles.sortBar}>
        <button
          type="button"
          className={category === '' ? 'pill-active' : 'pill'}
          onClick={() => setFilters({ category: '' })}
        >
          {t('home.allCategories')}
        </button>
        {categoryCounts.map((cat) => (
          <button
            key={cat.category}
            type="button"
            className={category === cat.category ? 'pill-active' : 'pill'}
            onClick={() => setFilters({ category: cat.category })}
          >
            {t(`home.categories.${cat.category}`, { defaultValue: cat.category })} ({cat.count})
          </button>
        ))}
      </div>

      <div style={styles.sortBar}>
        {QUICK_SORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={sort === opt.value ? 'pill-active' : 'pill'}
            onClick={() => handleSortChange(opt.value)}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={styles.grid}>
          {Array.from({ length: 6 }, (_, i) => (
            <CampaignCardSkeleton key={i} />
          ))}
        </div>
      ) : listError ? (
        <p className="alert alert--error" role="alert">
          {listError}
        </p>
      ) : campaigns.length === 0 ? (
        <div className="alert alert--info">
          {hasActiveFilters ? (
            <>
              {t('home.noMatches')}{' '}
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setSearchParams({}, { replace: true });
                }}
                style={{
                  background: 'transparent',
                  color: 'var(--color-info-text)',
                  fontWeight: 700,
                  textDecoration: 'underline',
                  padding: 0,
                  minHeight: 'auto',
                }}
              >
                {t('common.clearFilters')}
              </button>
            </>
          ) : user && (user.role === 'creator' || user.role === 'admin') ? (
            <>
              {t('home.noCampaigns')}{' '}
              <Link
                to="/campaigns/new"
                style={{ color: 'var(--color-info-text)', fontWeight: 700 }}
              >
                {t('home.startCampaign')}
              </Link>
              .
            </>
          ) : (
            <>{t('home.noPublicCampaigns')}</>
          )}
        </div>
      ) : (
        <>
          <div style={styles.grid}>
            {campaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} />
            ))}
          </div>
          {loadingMore && (
            <div aria-busy="true" aria-live="polite" style={{ ...styles.grid, marginTop: '1.25rem' }}>
              {Array.from({ length: 4 }, (_, i) => (
                <CampaignCardSkeleton key={`pagination-skeleton-${i}`} />
              ))}
            </div>
          )}
          <div style={styles.pagination}>
            <span style={styles.paginationInfo}>
              {t('home.showingCampaigns', { count: campaigns.length, total })}
            </span>
            {hasMore && (
              <div style={styles.loadMoreContainer}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={styles.loadMoreButton}
                >
                  {loadingMore ? t('home.loadingMore') : t('home.loadMore')}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

const styles = {
  hero: { textAlign: 'center', padding: '2rem 0 2.5rem' },
  h1: {
    fontSize: 'clamp(1.85rem, 5vw, 2.85rem)',
    fontWeight: 800,
    marginBottom: '1rem',
    color: 'var(--color-text-primary)',
  },
  sub: {
    fontSize: 'clamp(0.95rem, 2.5vw, 1.1rem)',
    color: 'var(--color-text-secondary)',
    marginBottom: '1.5rem',
    maxWidth: '560px',
    margin: '0 auto 1.5rem',
    lineHeight: 1.55,
  },
  muted: {
    fontSize: '0.85rem',
    color: 'var(--color-text-hint)',
    maxWidth: '320px',
    lineHeight: 1.4,
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: 700,
    marginBottom: '1.1rem',
    color: 'var(--color-text-primary)',
  },
  sortBar: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '1.25rem',
    flexWrap: 'wrap',
  },
  filterBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '1rem',
    marginBottom: '1.25rem',
  },
  filterItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.35rem',
    fontSize: '0.9rem',
    color: 'var(--color-text-primary)',
  },
  filterInput: {
    width: '100%',
    padding: '0.75rem',
    borderRadius: '8px',
    border: '1px solid var(--color-border)',
    fontSize: '0.95rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
    gap: '1.25rem',
  },
  pagination: {
    marginTop: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
  },
  paginationInfo: { color: 'var(--color-text-secondary)', fontSize: '0.95rem' },
  loadMoreContainer: { display: 'flex', justifyContent: 'center', width: '100%' },
  loadMoreButton: {
    padding: '0.75rem 2rem',
    fontSize: '1.05rem',
    cursor: 'pointer',
    borderRadius: '8px',
    border: '1px solid var(--color-border)',
  },
};
