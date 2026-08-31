import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api } from '../services/api';

const EVENT_TYPES = [
  { id: 'campaign_updates', label: 'Campaign updates', description: 'New updates posted on campaigns you support' },
  { id: 'refunds', label: 'Refunds', description: 'Refunds and contribution receipts' },
  { id: 'disputes', label: 'Dispute notifications', description: 'Disputes opened, updated, or resolved' },
  { id: 'milestones', label: 'Milestone completions', description: 'Milestones reached or approved' },
  { id: 'marketing', label: 'Marketing & Weekly digest', description: 'A summary of activity delivered once a week' },
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
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState({
    campaign_updates: true,
    refunds: true,
    disputes: true,
    milestones: true,
    marketing: false,
  });

  const loadPreferences = useCallback(async () => {
    try {
      const data = await api.getNotificationPreferences();
      if (data) {
        setPrefs(data);
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
      api.unsubscribeEmail({ email, category, sig, campaign_id: campaignId })
        .then(() => {
          toast('Successfully unsubscribed', 'success');
          loadPreferences(); // reload to show new state
        })
        .catch(err => {
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

  const handleQuickSetting = async (mode) => {
    let newPrefs;
    if (mode === 'everything') {
      newPrefs = { campaign_updates: true, refunds: true, disputes: true, milestones: true, marketing: true };
    } else if (mode === 'important') {
      newPrefs = { campaign_updates: true, refunds: true, disputes: true, milestones: true, marketing: false };
    } else if (mode === 'nothing') {
      newPrefs = { campaign_updates: false, refunds: false, disputes: false, milestones: false, marketing: false };
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
          Please <Link to="/login" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>log in</Link> to manage notification settings.
        </p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="container page-narrow notif-settings" style={{ paddingTop: '3rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '1.5rem' }}>Notification Settings</h1>
        <div className="campaign-card">
          <p style={{ color: 'var(--color-text-hint)' }}>Loading your preferences…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="container page-narrow notif-settings" style={{ paddingTop: '3rem', paddingBottom: '4rem' }}>
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

      <SectionCard
        title="Quick Settings"
        description="Quickly set your email preferences."
      >
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
          <button className="btn-secondary" onClick={() => handleQuickSetting('everything')}>Email me everything</button>
          <button className="btn-secondary" onClick={() => handleQuickSetting('important')}>Important only</button>
          <button className="btn-secondary" onClick={() => handleQuickSetting('nothing')}>Email me nothing</button>
        </div>
      </SectionCard>

      <SectionCard
        title="Email Notifications"
        description="Choose which categories of emails you want to receive."
      >
        <div className="notif-settings__types-table">
          {EVENT_TYPES.map((evt) => (
            <div key={evt.id} className="notif-settings__types-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '1rem 0', borderBottom: '1px solid #eceef1' }}>
              <div className="notif-settings__types-info">
                <span style={{ fontWeight: 600, fontSize: '0.9rem', display: 'block' }}>{evt.label}</span>
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
    </main>
  );
}
