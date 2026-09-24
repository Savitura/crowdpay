import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  dismissCreatorChecklist,
  getCreatorChecklistProgress,
  isCreatorChecklistDismissed,
  shouldShowCreatorChecklist,
} from '../lib/onboarding';
import { loadDraft } from '../lib/campaignDraft';

/**
 * Lightweight creator onboarding checklist for the dashboard.
 * Progress is derived from already-loaded user/campaign state (no extra fetches).
 */
export default function CreatorOnboardingChecklist({ user, campaigns = [], stats = null }) {
  const [dismissed, setDismissed] = useState(() => isCreatorChecklistDismissed());

  const draftForm = useMemo(() => {
    try {
      return loadDraft()?.form || null;
    } catch {
      return null;
    }
  }, []);

  const progress = useMemo(
    () => getCreatorChecklistProgress(user, campaigns, draftForm),
    [user, campaigns, draftForm]
  );

  const visible = shouldShowCreatorChecklist({ user, campaigns, stats, dismissed });
  if (!visible) return null;

  function handleDismiss() {
    dismissCreatorChecklist();
    setDismissed(true);
  }

  return (
    <section
      className="creator-checklist"
      aria-label="Campaign creator onboarding checklist"
      data-testid="creator-onboarding-checklist"
    >
      <div className="creator-checklist__header">
        <div>
          <h2 className="creator-checklist__title">Creator setup checklist</h2>
          <p className="creator-checklist__subtitle">
            Finish these steps to launch your first campaign and start receiving contributions.
          </p>
        </div>
        <button type="button" className="creator-checklist__dismiss" onClick={handleDismiss}>
          Dismiss
        </button>
      </div>

      <div className="creator-checklist__progress" aria-label={`${progress.percent}% complete`}>
        <div className="progress-bar" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar-fill" style={{ width: `${progress.percent}%`, background: 'var(--color-accent)' }} />
        </div>
        <span className="creator-checklist__percent">
          {progress.doneCount}/{progress.total} · {progress.percent}%
        </span>
      </div>

      <ul className="creator-checklist__list">
        {progress.items.map((item) => (
          <li key={item.id} className={`creator-checklist__item${item.done ? ' is-done' : ''}`}>
            <span className="creator-checklist__check" aria-hidden="true">
              {item.done ? '✓' : ''}
            </span>
            {item.done ? (
              <span className="creator-checklist__label">{item.label}</span>
            ) : (
              <Link className="creator-checklist__link" to={item.href}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <p className="creator-checklist__hint">
        You can reopen this checklist anytime from{' '}
        <Link to="/profile">account settings</Link>.
      </p>
    </section>
  );
}
