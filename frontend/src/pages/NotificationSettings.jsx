import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api } from '../services/api';
import CategoryFollows from '../components/CategoryFollows';

const EVENT_TYPES = [
  {
    id: 'campaign_updates',
    label: 'Campaign updates',
    description: 'New updates posted on campaigns you support',
  },
  { id: 'refunds', label: 'Refunds', description: 'Refunds and contribution receipts' },
  {
    id: 'disputes',
    label: 'Dispute notifications',
    description: 'Disputes opened, updated, or resolved',
  },
  {
    id: 'milestones',
    label: 'Milestone completions',
    description: 'Milestones reached or approved',
  },
  {
    id: 'marketing',
    label: 'Marketing & Weekly digest',
    description: 'A summary of activity delivered once a week',
  },
  {
    id: 'category_digest',
    label: 'Category digest',
    description: 'New campaigns in the categories you follow, inside the weekly digest',
  },
];

function Toggle({ checked, onChange, disabled, label, id }) {
  return (
    <label className="notif-toggle" htmlFor={id}>
      <span className="notif-toggle__label">{label}</span>
      <span
        className={`notif-toggle__track${checked ? ' notif-toggle__track--on' : ''}`}
        aria-hidden="true"
      >
        <span className="notif-toggle__thumb" />
      </span>
      <input
        id={id}
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="notif-toggle__input"
      />
    </label>
  );
}

function SectionCard({ title, description, children }) {
  return (
    <div className="campaign-card notif-settings__card">
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.25rem' }}>{title}</h2>
        {description && (
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.875rem', margin: 0 }}>
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export default function NotificationSettings() {
  const { user, ready } = useAuth();
  const { t } = useTranslation();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState({
    campaign_updates: true,
    refunds: true,
    disputes: true,
    milestones: true,
    marketing: false,
    category_digest: true,
  });
  // Per-campaign overrides (#961). `campaignOverrides` only ever holds rows for
  // campaigns the caller actually muted something for.
  const [campaignOverrides, setCampaignOverrides] = useState([]);
  const [overridesLoading, setOverridesLoading] = useState(true);
  const [resetting, setResetting] = useState(false);

  const loadPreferences = useCallback(async () => {
    try {
      const data = await api.getNotificationPreferences();
      if (data) {
        setPrefs((prev) => ({ ...prev, ...data }));
      }
    } catch (err) {
      toast(err.message || 'Failed to load notification settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Handle unsubscribe links from emails
  useEffect(() => {
    const email = searchParams.get('email');
    const category = searchParams.get('category');
    const sig = searchParams.get('sig');
    const campaignId = searchParams.get('campaign_id');

    if (email && category && sig) {
      api
        .unsubscribeEmail({ email, category, sig, campaign_id: campaignId })
        .then(() => {
          toast('Successfully unsubscribed', 'success');
          loadPreferences(); // reload to show new state
        })
        .catch((err) => {
          toast(err.response?.data?.error || err.message || 'Failed to unsubscribe', 'error');
        });
    } else {
      loadPreferences();
    }
  }, [loadPreferences, searchParams, toast]);

  const handleToggle = async (key, enabled) => {
    const newPrefs = { ...prefs, [key]: enabled };
    setPrefs(newPrefs);
    try {
      await api.updateNotificationPreference(newPrefs);
    } catch (err) {
      toast(err.message || 'Failed to save preference', 'error');
      setPrefs(prefs); // revert
    }
  };

  // Per-campaign overrides are a separate resource from the account-level
  // switches, so they load (and fail) independently of `prefs`.
  useEffect(() => {
    let active = true;
    api
      .getMyCommunicationPreferences()
      .then((data) => {
        if (active) setCampaignOverrides(data?.campaigns || []);
      })
      .catch(() => {
        if (active) setCampaignOverrides([]);
      })
      .finally(() => {
        if (active) setOverridesLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleResetCampaignOverrides = async () => {
    setResetting(true);
    try {
      await api.resetMyCommunicationPreferences();
      setCampaignOverrides([]);
      toast(t('communicationPreferences.reset'), 'success');
    } catch (err) {
      toast(err.message || t('communicationPreferences.saveError'), 'error');
    } finally {
      setResetting(false);
    }
  };

  const handleQuickSetting = async (mode) => {
    let newPrefs;
    if (mode === 'everything') {
      newPrefs = {
        campaign_updates: true,
        refunds: true,
        disputes: true,
        milestones: true,
        marketing: true,
        category_digest: true,
      };
    } else if (mode === 'important') {
      newPrefs = {
        campaign_updates: true,
        refunds: true,
        disputes: true,
        milestones: true,
        marketing: false,
        category_digest: true,
      };
    } else if (mode === 'nothing') {
      newPrefs = {
        campaign_updates: false,
        refunds: false,
        disputes: false,
        milestones: false,
        marketing: false,
        category_digest: false,
      };
    }

    setPrefs(newPrefs);
    try {
      await api.updateNotificationPreference(newPrefs);
      toast('Preferences updated', 'success');
    } catch (err) {
      toast(err.message || 'Failed to save preference', 'error');
      loadPreferences();
    }
  };

  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Loading session…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--error">
          Please{' '}
          <Link to="/login" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
            log in
          </Link>{' '}
          to manage notification settings.
        </p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="container page-narrow notif-settings" style={{ paddingTop: '3rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '1.5rem' }}>
          Notification Settings
        </h1>
        <div className="campaign-card">
          <p style={{ color: 'var(--color-text-hint)' }}>Loading your preferences…</p>
        </div>
      </main>
    );
  }

  return (
    <main
      className="container page-narrow notif-settings"
      style={{ paddingTop: '3rem', paddingBottom: '4rem' }}
    >
      <div style={{ marginBottom: '1.5rem' }}>
        <Link
          to="/profile"
          style={{ color: 'var(--color-text-hint)', fontSize: '0.875rem', fontWeight: 500 }}
        >
          ← Back to profile
        </Link>
      </div>

      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.5rem' }}>
        Notification Settings
      </h1>
      <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem', marginBottom: '2rem' }}>
        Control how and when you receive notifications from CrowdPay.
      </p>

      <SectionCard title="Quick Settings" description="Quickly set your email preferences.">
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
          <button className="btn-secondary" onClick={() => handleQuickSetting('everything')}>
            Email me everything
          </button>
          <button className="btn-secondary" onClick={() => handleQuickSetting('important')}>
            Important only
          </button>
          <button className="btn-secondary" onClick={() => handleQuickSetting('nothing')}>
            Email me nothing
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Email Notifications"
        description="Choose which categories of emails you want to receive."
      >
        <div className="notif-settings__types-table">
          {EVENT_TYPES.map((evt) => (
            <div
              key={evt.id}
              className="notif-settings__types-row"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '1rem 0',
                borderBottom: '1px solid #eceef1',
              }}
            >
              <div className="notif-settings__types-info">
                <span style={{ fontWeight: 600, fontSize: '0.9rem', display: 'block' }}>
                  {evt.label}
                </span>
                <span style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>
                  {evt.description}
                </span>
              </div>
              <div className="notif-settings__types-channels">
                <Toggle
                  id={`pref-${evt.id}`}
                  checked={prefs[evt.id]}
                  onChange={(enabled) => handleToggle(evt.id, enabled)}
                  label=""
                />
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Per-campaign overrides (#961). Empty until the caller mutes a channel
          on a specific campaign, which is why this is its own section rather
          than another row in the table above. */}
      <SectionCard
        title={t('communicationPreferences.title')}
        description={t('communicationPreferences.subtitle')}
      >
        {overridesLoading ? (
          <p role="status" style={{ color: 'var(--color-text-hint)' }}>
            {t('communicationPreferences.loading')}
          </p>
        ) : campaignOverrides.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)' }}>
            {t('communicationPreferences.noOverrides')}
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {campaignOverrides.map((row) => {
              const muted = [
                'updates',
                'milestones',
                'funding_updates',
                'messages',
                'surveys',
              ].filter((channel) => row[channel] === false);
              return (
                <div
                  key={row.campaign_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '1rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <Link
                    to={`/campaigns/${row.campaign_id}`}
                    style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                  >
                    {row.title}
                  </Link>
                  <span style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>
                    {muted
                      .map((channel) => t(`communicationPreferences.channels.${channel}`))
                      .join(', ')}
                  </span>
                </div>
              );
            })}
            <button
              type="button"
              className="btn-secondary"
              onClick={handleResetCampaignOverrides}
              disabled={resetting}
              style={{ justifySelf: 'start' }}
            >
              {resetting
                ? t('communicationPreferences.resetting')
                : t('communicationPreferences.reset')}
            </button>
          </div>
        )}
      </SectionCard>
    </main>
  );
}
