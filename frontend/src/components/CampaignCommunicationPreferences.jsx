import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

// Per-campaign communication preferences (#961).
//
// This sits between the account-wide `notification_preferences` switches
// (Notification settings) and the per-follower opt-ins on the follow button.
// Every channel defaults to on and the API resolves to those defaults when the
// contributor has never overridden anything, so the "loading" state is the only
// time the panel is blank.

export const COMMUNICATION_CHANNELS = [
  { id: 'updates' },
  { id: 'milestones' },
  { id: 'funding_updates' },
  { id: 'messages' },
  { id: 'surveys' },
];

export default function CampaignCommunicationPreferences({ campaignId, compact = false }) {
  const { t } = useTranslation();
  // `t` must not appear in the effect dependencies: react-i18next hands back a
  // new translator identity on every render, which would re-run the fetch (and
  // its setLoading(true)) forever. The ref keeps the loader stable.
  const tRef = useRef(t);
  tRef.current = t;

  const [preferences, setPreferences] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingChannel, setSavingChannel] = useState(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .getCampaignCommunicationPreferences(campaignId)
      .then((data) => {
        if (active) setPreferences(data);
      })
      .catch((err) => {
        if (active) setError(err.message || tRef.current('communicationPreferences.loadError'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [campaignId]);

  const toggleChannel = useCallback(
    async (channel) => {
      const next = !preferences?.[channel];
      // Optimistic: the checkbox reflects the intent immediately and rolls
      // back if the write fails, so a slow network never desyncs the UI.
      setPreferences((prev) => ({ ...prev, [channel]: next }));
      setSavingChannel(channel);
      setError('');
      try {
        const saved = await api.setCampaignCommunicationPreferences(campaignId, {
          [channel]: next,
        });
        setPreferences(saved);
      } catch (err) {
        setPreferences((prev) => ({ ...prev, [channel]: !next }));
        setError(err.message || t('communicationPreferences.saveError'));
      } finally {
        setSavingChannel(null);
      }
    },
    [campaignId, preferences, t]
  );

  const resetAll = useCallback(async () => {
    setResetting(true);
    setError('');
    try {
      setPreferences(await api.resetCampaignCommunicationPreferences(campaignId));
    } catch (err) {
      setError(err.message || t('communicationPreferences.saveError'));
    } finally {
      setResetting(false);
    }
  }, [campaignId, t]);

  const hasOverrides = COMMUNICATION_CHANNELS.some(
    (channel) => preferences?.[channel.id] === false
  );

  return (
    <section
      className="campaign-card"
      aria-labelledby="communication-preferences-heading"
      style={{ fontSize: '0.9rem' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <h3
          id="communication-preferences-heading"
          style={{ fontSize: compact ? '0.95rem' : '1.05rem', margin: 0 }}
        >
          {t('communicationPreferences.title')}
        </h3>
        {hasOverrides && (
          <button
            type="button"
            className="btn-secondary"
            onClick={resetAll}
            disabled={resetting}
            style={{ fontSize: '0.8rem', padding: '0.3rem 0.7rem' }}
          >
            {resetting
              ? t('communicationPreferences.resetting')
              : t('communicationPreferences.reset')}
          </button>
        )}
      </div>

      {!compact && (
        <p style={{ color: 'var(--color-text-hint)', marginTop: '0.35rem' }}>
          {t('communicationPreferences.subtitle')}
        </p>
      )}

      {loading && (
        <p role="status" style={{ color: 'var(--color-text-hint)' }}>
          {t('communicationPreferences.loading')}
        </p>
      )}

      {!loading && preferences && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '0.75rem 0 0',
            display: 'grid',
            gap: '0.5rem',
          }}
        >
          {COMMUNICATION_CHANNELS.map((channel) => {
            const inputId = `comm-pref-${campaignId}-${channel.id}`;
            return (
              <li
                key={channel.id}
                style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
              >
                <input
                  id={inputId}
                  type="checkbox"
                  checked={preferences[channel.id] !== false}
                  disabled={savingChannel === channel.id}
                  onChange={() => toggleChannel(channel.id)}
                  aria-describedby={`${inputId}-help`}
                  style={{ width: 'auto', marginTop: '0.15rem' }}
                />
                <span>
                  <label htmlFor={inputId} style={{ fontWeight: 600, cursor: 'pointer' }}>
                    {t(`communicationPreferences.channels.${channel.id}`)}
                  </label>
                  <span
                    id={`${inputId}-help`}
                    style={{
                      display: 'block',
                      color: 'var(--color-text-hint)',
                      fontSize: '0.8rem',
                    }}
                  >
                    {t(`communicationPreferences.channels.${channel.id}Help`)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--color-status-error)', marginTop: '0.75rem' }}>
          {error}
        </p>
      )}
    </section>
  );
}
