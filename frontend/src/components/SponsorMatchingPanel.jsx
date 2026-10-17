import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';
import { MatchProgressBar, SponsorBadgesRow } from './MatchProgressBar';

const SPONSORABLE_STATUSES = new Set(['active', 'funded', 'in_progress']);
const MAX_MATCH_RATIO = 100;

/**
 * SponsorMatchingPanel — the user-facing half of sponsor-funded matching
 * campaigns (#948).
 *
 * Renders the live matching progress for a campaign and, for signed-in users,
 * lets a sponsor pledge matching funds of their own. Progress is public; the
 * pledge form is not.
 *
 * @param {Object} props
 * @param {string} props.campaignId - Campaign UUID
 * @param {string} [props.campaignStatus] - Current campaign status
 * @param {Object|null} [props.user] - Authenticated user
 */
export default function SponsorMatchingPanel({ campaignId, campaignStatus, user }) {
  const { t } = useTranslation();
  const showToast = useToast();

  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [pledgeAmount, setPledgeAmount] = useState('');
  const [matchRatio, setMatchRatio] = useState('1');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [closingId, setClosingId] = useState(null);
  // The public progress payload never carries sponsor identities, so ownership
  // of a pledge is resolved through the authenticated "my pledges" endpoint.
  const [myMatchIds, setMyMatchIds] = useState(() => new Set());

  const loadProgress = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.getCampaignMatchingProgress(campaignId);
      setProgress(data);
    } catch (err) {
      setError(err.message || t('sponsorMatching.error'));
      setProgress(null);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  const loadMyPledges = useCallback(async () => {
    if (!campaignId || !user) {
      setMyMatchIds(new Set());
      return;
    }
    try {
      const data = await api.getMySponsorMatches();
      const ids = (data?.pledges || [])
        .filter((pledge) => String(pledge.campaignId) === String(campaignId))
        .map((pledge) => String(pledge.id));
      setMyMatchIds(new Set(ids));
    } catch {
      setMyMatchIds(new Set());
    }
  }, [campaignId, user]);

  useEffect(() => {
    loadProgress();
    loadMyPledges();
  }, [loadProgress, loadMyPledges]);

  const matches = progress?.matches || [];
  const sponsors = matches.filter((match) => match.status !== 'completed');
  const isSponsorable = SPONSORABLE_STATUSES.has(campaignStatus);
  const canPledge = Boolean(user) && isSponsorable;

  const resetForm = () => {
    setPledgeAmount('');
    setMatchRatio('1');
    setFormError('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const amount = Number(pledgeAmount);
    const ratio = Number(matchRatio);

    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError(t('sponsorMatching.invalidAmount'));
      return;
    }
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > MAX_MATCH_RATIO) {
      setFormError(t('sponsorMatching.invalidRatio'));
      return;
    }

    setSubmitting(true);
    try {
      await api.createSponsorMatchingPledge(campaignId, {
        match_ratio: ratio,
        pledge_amount: String(amount),
      });
      showToast?.(t('sponsorMatching.created'), 'success');
      resetForm();
      setFormOpen(false);
      await Promise.all([loadProgress(), loadMyPledges()]);
    } catch (err) {
      const message =
        err.status === 409
          ? t('sponsorMatching.duplicate')
          : err.message || t('sponsorMatching.createFailed');
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClosePledge = async (matchId) => {
    setClosingId(matchId);
    try {
      await api.completeSponsorMatchingPledge(campaignId, matchId);
      showToast?.(t('sponsorMatching.closed'), 'success');
      await Promise.all([loadProgress(), loadMyPledges()]);
    } catch (err) {
      showToast?.(err.message || t('sponsorMatching.closeFailed'), 'error');
    } finally {
      setClosingId(null);
    }
  };

  return (
    <section className="campaign-card" style={{ marginBottom: '1.5rem' }} aria-live="polite">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>
            {t('sponsorMatching.title')}
          </h3>
          <p
            style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-muted)' }}
          >
            {t('sponsorMatching.subtitle')}
          </p>
        </div>
        {canPledge && !formOpen && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setFormOpen(true)}
            style={{ fontSize: '0.85rem' }}
          >
            {t('sponsorMatching.createPledge')}
          </button>
        )}
      </div>

      {loading && (
        <p style={{ margin: '1rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
          {t('sponsorMatching.loading')}
        </p>
      )}

      {!loading && error && (
        <div role="alert" style={{ marginTop: '1rem' }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#c53030' }}>{error}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={loadProgress}
            style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}
          >
            {t('sponsorMatching.retry')}
          </button>
        </div>
      )}

      {!loading && !error && progress && (
        <>
          {sponsors.length === 0 ? (
            <p
              style={{ margin: '1rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-muted)' }}
            >
              {t('sponsorMatching.empty')}
            </p>
          ) : (
            <>
              <MatchProgressBar
                campaignId={campaignId}
                totalPledged={progress.totalPledged}
                totalMatched={progress.totalMatched}
                matchRatio={sponsors[0]?.matchRatio ?? 1}
              />
              <SponsorBadgesRow matches={sponsors} />
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: '0.75rem 0 0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                }}
              >
                {sponsors.map((match) => {
                  const isOwnPledge = myMatchIds.has(String(match.id));
                  const ratio = Number(match.matchRatio);
                  return (
                    <li
                      key={match.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.82rem',
                        color: 'var(--color-text-secondary)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span>
                        {t('sponsorMatching.matchedProgress', {
                          matched: match.matchedAmount,
                          pledged: match.pledgeAmount,
                        })}
                        {ratio ? ` · ${ratio % 1 === 0 ? ratio : ratio.toFixed(1)}:1` : ''}
                      </span>
                      {isOwnPledge && match.status !== 'completed' && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={closingId === match.id}
                          onClick={() => handleClosePledge(match.id)}
                          style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}
                        >
                          {closingId === match.id
                            ? t('sponsorMatching.closing')
                            : t('sponsorMatching.closePledge')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {progress.remainingPoolAmount > 0 && sponsors.length > 0 && (
            <p
              style={{
                margin: '0.75rem 0 0',
                fontSize: '0.8rem',
                color: 'var(--color-text-muted)',
              }}
            >
              {t('sponsorMatching.remainingPool', { amount: progress.remainingPoolAmount })}
            </p>
          )}
        </>
      )}

      {formOpen && (
        <form onSubmit={handleSubmit} style={{ marginTop: '1rem' }} noValidate>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
                fontSize: '0.8rem',
                flex: '1 1 160px',
              }}
            >
              {t('sponsorMatching.pledgeAmount')}
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={pledgeAmount}
                onChange={(event) => setPledgeAmount(event.target.value)}
                placeholder={t('sponsorMatching.pledgeAmountPlaceholder')}
                aria-label={t('sponsorMatching.pledgeAmount')}
                required
              />
            </label>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
                fontSize: '0.8rem',
                flex: '1 1 120px',
              }}
            >
              {t('sponsorMatching.matchRatio')}
              <input
                type="number"
                min="0"
                max={MAX_MATCH_RATIO}
                step="any"
                inputMode="decimal"
                value={matchRatio}
                onChange={(event) => setMatchRatio(event.target.value)}
                aria-label={t('sponsorMatching.matchRatio')}
                required
              />
            </label>
          </div>
          <p
            style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
          >
            {t('sponsorMatching.matchRatioHint')}
          </p>

          {formError && (
            <p role="alert" style={{ margin: '0.5rem 0 0', fontSize: '0.82rem', color: '#c53030' }}>
              {formError}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? t('sponsorMatching.submitting') : t('sponsorMatching.submit')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={submitting}
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
