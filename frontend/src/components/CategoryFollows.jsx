import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

export const FOLLOWABLE_CATEGORIES = [
  'technology',
  'community',
  'arts',
  'education',
  'environment',
  'health',
  'business',
  'open_source',
  'other',
];

export function categoryLabel(category) {
  return category
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Shared category-follow state: loading / error / followed set + toggle.
 * Optimistic updates with revert on failure so double-taps stay consistent
 * with the idempotent backend (200 on repeat follow, 204 on repeat unfollow).
 */
export function useCategoryFollows() {
  const { user } = useAuth();
  const userId = user?.id || null;
  const [categories, setCategories] = useState([]);
  const [followed, setFollowed] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [all, mine] = await Promise.all([
        api.getCategories().catch(() => null),
        userId ? api.getCategoryFollows().catch(() => []) : Promise.resolve([]),
      ]);
      const list =
        Array.isArray(all) && all.length
          ? all
          : FOLLOWABLE_CATEGORIES.map((category) => ({ category }));
      setCategories(list);
      const mineSet = new Set(
        (Array.isArray(mine) ? mine : []).map((row) =>
          typeof row === 'string' ? row : row.category
        )
      );
      // The public list also carries `following` when authenticated.
      for (const entry of list) {
        if (entry.following) mineSet.add(entry.category);
      }
      setFollowed(mineSet);
    } catch (err) {
      setError(err.message || 'Could not load categories');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback(
    async (category) => {
      if (!userId || pending.has(category)) return;
      const isFollowing = followed.has(category);
      setPending((prev) => new Set(prev).add(category));
      setError('');
      setFollowed((prev) => {
        const next = new Set(prev);
        if (isFollowing) next.delete(category);
        else next.add(category);
        return next;
      });
      try {
        if (isFollowing) await api.unfollowCategory(category);
        else await api.followCategory(category);
      } catch (err) {
        // Revert the optimistic update so UI matches the server.
        setFollowed((prev) => {
          const next = new Set(prev);
          if (isFollowing) next.add(category);
          else next.delete(category);
          return next;
        });
        setError(err.message || 'Could not update category follow');
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(category);
          return next;
        });
      }
    },
    [followed, pending, userId]
  );

  return { categories, followed, loading, error, pending, toggle, reload: load };
}

export function CategoryFollowToggle({ category, following, disabled, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(category)}
      disabled={disabled}
      aria-pressed={following}
      title={
        following
          ? `Stop following ${categoryLabel(category)}`
          : `Follow ${categoryLabel(category)} for a weekly digest`
      }
      style={{
        background: 'none',
        border: '1px solid var(--color-border-lighter)',
        borderRadius: '999px',
        fontSize: '0.75rem',
        padding: '0.1rem 0.5rem',
        cursor: disabled ? 'wait' : 'pointer',
        color: following ? 'var(--color-accent)' : 'var(--color-text-hint)',
        fontWeight: following ? 700 : 400,
      }}
    >
      {following ? '✓ Following' : '+ Follow'}
    </button>
  );
}

/**
 * Full section for settings/profile pages: loading, empty, list, and error
 * states with a retry action.
 */
export default function CategoryFollows() {
  const { user } = useAuth();
  const { categories, followed, loading, error, pending, toggle, reload } = useCategoryFollows();

  if (!user) {
    return (
      <p className="alert alert--info">
        Log in to follow categories and receive a weekly digest of new campaigns.
      </p>
    );
  }

  if (loading) {
    return <p style={{ color: 'var(--color-text-hint)' }}>Loading categories…</p>;
  }

  if (!categories.length) {
    return (
      <div>
        {error && <p className="alert alert--error">{error}</p>}
        <p className="alert alert--info">No categories are available right now.</p>
        <button type="button" className="btn-secondary" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <p className="alert alert--error" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={reload}
            style={{
              background: 'transparent',
              textDecoration: 'underline',
              fontWeight: 700,
              padding: 0,
            }}
          >
            Try again
          </button>
        </p>
      )}
      {followed.size === 0 && (
        <p className="alert alert--info">
          You are not following any categories yet. Follow one to get new campaigns in your weekly
          digest.
        </p>
      )}
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {categories.map((entry) => {
          const category = entry.category;
          const isFollowing = followed.has(category);
          return (
            <div
              key={category}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.6rem 0',
                borderBottom: '1px solid #eceef1',
              }}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', display: 'block' }}>
                  {categoryLabel(category)}
                </span>
                <span style={{ color: 'var(--color-text-hint)', fontSize: '0.78rem' }}>
                  {typeof entry.active_campaigns === 'number'
                    ? `${entry.active_campaigns} active · `
                    : ''}
                  {typeof entry.follower_count === 'number'
                    ? `${entry.follower_count} follower${entry.follower_count === 1 ? '' : 's'}`
                    : 'New campaigns in your weekly digest'}
                </span>
              </div>
              <CategoryFollowToggle
                category={category}
                following={isFollowing}
                disabled={pending.has(category)}
                onToggle={toggle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
