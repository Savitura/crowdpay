import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
  { value: 'newest', label: 'Newest' },
  { value: 'ending_soon', label: 'Ending soon' },
  { value: 'most_funded', label: 'Most funded' },
  { value: 'most_backed', label: 'Most backed' },
];

export default function Home() {
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const { user } = useAuth();
  const [showContributorTips, setShowContributorTips] = useState(isContributorOnboardingVisible);
  const [welcomeNewUser, setWelcomeNewUser] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || '';
  const asset = searchParams.get('asset') || '';
  const sort = searchParams.get('sort') || 'newest';
  const limit = Number(searchParams.get('limit') || 20);
  const offset = Number(searchParams.get('offset') || 0);

  const page = Math.floor(offset / limit) + 1;
  const lastItem = Math.min(total, offset + campaigns.length);

  useEffect(() => {
    if (consumeJustRegistered()) {
      setWelcomeNewUser(true);
    }
  }, []);

  useEffect(() => {
    setListError('');
    setLoading(true);
    api
      .getCampaigns({ search, status, asset, sort, limit, offset })
      .then((data) => {
        setCampaigns(data.campaigns || []);
        setTotal(data.total || 0);
      })
      .catch((err) => setListError(err.message || 'Could not load campaigns.'))
      .finally(() => setLoading(false));
  }, [search, status, asset, sort, limit, offset]);

  const setFilters = (next) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(next).forEach(([key, value]) => {
      if (value === '' || value == null) {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    });
    params.delete('offset');
    setSearchParams(params, { replace: true });
  };

  const setPageOffset = (nextOffset) => {
    const params = new URLSearchParams(searchParams);
    if (nextOffset <= 0) {
      params.delete('offset');
    } else {
      params.set('offset', String(nextOffset));
    }
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
          <strong>Welcome to CrowdPay.</strong> Your account includes a custodial Stellar wallet. Follow the instructions sent to your email to get started. Explore active
          campaigns and fund one in seconds.
          <button
            type="button"
            onClick={() => setWelcomeNewUser(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: '#065f46',
              fontWeight: 600,
              textDecoration: 'underline',
              padding: 0,
              minHeight: 'auto',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {user && showContributorTips && (
        <OnboardingCallout title="How contributing works" onDismiss={dismissContributorTips}>
          <ul>
            <li>Each campaign settles in either USDC or XLM — that is what moves the progress bar.</li>
            <li>You can pay with XLM or USDC; if they differ, Stellar converts automatically when a path exists.</li>
            <li>Watch for live quotes in the contribute window before you confirm.</li>
          </ul>
        </OnboardingCallout>
      )}

      <div style={styles.hero}>
        <h1 style={styles.h1}>Fund anything, from anywhere.</h1>
        <p style={styles.sub}>
          CrowdPay runs on Stellar: fast settlement, optional cross-asset conversion, and a clear path from pledge to
          on-chain receipt.
        </p>
        {user ? (
          <div className="hero-actions">
            {(user.role === 'creator' || user.role === 'admin') && (
              <Link to="/campaigns/new" style={{ width: '100%' }}>
                <button type="button" className="btn-primary" style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}>
                  Start a campaign
                </button>
              </Link>
            )}
            <span style={styles.muted}>or browse below and tap a card to contribute.</span>
          </div>
        ) : (
          <div className="hero-actions hero-actions--row-sm">
            <Link to="/register" style={{ flex: '1 1 140px', minWidth: '140px' }}>
              <button type="button" className="btn-primary" style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}>
                Create account
              </button>
            </Link>
            <Link to="/login" style={{ flex: '1 1 140px', minWidth: '140px' }}>
              <button type="button" className="btn-secondary" style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}>
                Log in
              </button>
            </Link>
          </div>
        )}
      </div>

      <div style={styles.filterBar}>
        <label style={styles.filterItem}>
          Search
          <input
            value={search}
            onChange={(e) => setFilters({ search: e.target.value })}
            placeholder="Search campaigns"
            style={styles.filterInput}
          />
        </label>
        <label style={styles.filterItem}>
          Status
          <select
            value={status}
            onChange={(e) => setFilters({ status: e.target.value })}
            style={styles.filterInput}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === '' ? 'Any status' : option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.filterItem}>
          Asset
          <select
            value={asset}
            onChange={(e) => setFilters({ asset: e.target.value })}
            style={styles.filterInput}
          >
            {ASSET_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === '' ? 'Any asset' : option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.filterItem}>
          Sort by
          <select
            value={sort}
            onChange={(e) => setFilters({ sort: e.target.value })}
            style={styles.filterInput}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h2 style={styles.sectionTitle}>Active campaigns</h2>

      {loading ? (
        <div style={styles.grid}>
          {Array.from({ length: 6 }, (_, i) => <CampaignCardSkeleton key={i} />)}
        </div>
      ) : listError ? (
        <p className="alert alert--error" role="alert">
          {listError}
        </p>
      ) : campaigns.length === 0 ? (
        <div className="alert alert--info">
          {user && (user.role === 'creator' || user.role === 'admin') ? (
            <>
              No campaigns yet.{' '}
              <Link to="/campaigns/new" style={{ color: '#1e40af', fontWeight: 700 }}>
                Launch the first one
              </Link>
              .
            </>
          ) : (
            <>No public campaigns yet. Sign up to get notified when you create or back the first project.</>
          )}
        </div>
      ) : (
        <>
          <div style={styles.grid}>
            {campaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} />
            ))}
          </div>
          <div style={styles.pagination}>
            <span style={styles.paginationInfo}>
              Showing {campaigns.length ? offset + 1 : 0}–{lastItem} of {total} campaigns
            </span>
            <div style={styles.paginationButtons}>
              <button
                type="button"
                className="btn-secondary"
                disabled={offset === 0}
                onClick={() => setPageOffset(Math.max(0, offset - limit))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={offset + limit >= total}
                onClick={() => setPageOffset(offset + limit)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

const styles = {
  hero: { textAlign: 'center', padding: '2rem 0 2.5rem' },
  h1: { fontSize: 'clamp(1.85rem, 5vw, 2.85rem)', fontWeight: 800, marginBottom: '1rem', color: '#111' },
  sub: {
    fontSize: 'clamp(0.95rem, 2.5vw, 1.1rem)',
    color: '#555',
    marginBottom: '1.5rem',
    maxWidth: '560px',
    margin: '0 auto 1.5rem',
    lineHeight: 1.55,
  },
  muted: { fontSize: '0.85rem', color: '#777', maxWidth: '320px', lineHeight: 1.4, textAlign: 'center' },
  sectionTitle: { fontSize: '1.2rem', fontWeight: 700, marginBottom: '1.1rem', color: '#111' },
  filterBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '1rem',
    marginBottom: '1.25rem',
  },
  filterItem: { display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.9rem', color: '#333' },
  filterInput: { width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid #d4d4d8', fontSize: '0.95rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: '1.25rem' },
  pagination: { marginTop: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' },
  paginationInfo: { color: '#555', fontSize: '0.95rem' },
  paginationButtons: { display: 'flex', gap: '0.75rem' },
};
