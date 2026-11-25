import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../services/api';

const SUPPORTED_LOCALES = [
  { code: 'fr', label: 'French (Français)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'de', label: 'German (Deutsch)' },
];

export default function CampaignEditModal({
  isOpen,
  campaign,
  onClose,
  onSaved,
  token,
  milestones = [],
  setMilestones,
  currentLocale = 'en',
}) {
  const modalRef = useRef(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    deadline: '',
    target_amount: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Translations state
  const [translations, setTranslations] = useState([]);
  const [translationsLoading, setTranslationsLoading] = useState(false);
  const [translationForm, setTranslationForm] = useState(null);
  const [translationError, setTranslationError] = useState('');
  const [translationSuccess, setTranslationSuccess] = useState('');
  const [translationSaving, setTranslationSaving] = useState(false);

  useEffect(() => {
    if (isOpen && campaign) {
      setFormData({
        title: campaign.title || '',
        description: campaign.description || '',
        deadline: campaign.deadline ? campaign.deadline.split('T')[0] : '',
        target_amount: campaign.target_amount !== undefined ? String(campaign.target_amount) : '',
      });
      setError('');
      setTranslationForm(null);
      setTranslationError('');
      setTranslationSuccess('');

      setTranslationsLoading(true);
      api
        .getCampaignTranslations(campaign.id)
        .then((data) => setTranslations(Array.isArray(data) ? data : []))
        .catch(() => setTranslations([]))
        .finally(() => setTranslationsLoading(false));
    }
  }, [isOpen, campaign]);

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !campaign) return null;

  function handleStartAddTranslation(locale) {
    const existing = translations.find((t) => t.locale === locale || t.language === locale);
    setTranslationError('');
    setTranslationSuccess('');
    if (existing) {
      let mt = existing.milestone_titles || [];
      if (typeof mt === 'string') {
        try {
          mt = JSON.parse(mt);
        } catch {
          mt = [];
        }
      }
      setTranslationForm({
        locale,
        title: existing.title || '',
        description: existing.description || '',
        milestone_titles: Array.isArray(mt) ? [...mt] : [],
      });
    } else {
      setTranslationForm({
        locale,
        title: '',
        description: '',
        milestone_titles: (milestones || []).map(() => ''),
      });
    }
  }

  async function handleSaveTranslation() {
    if (!translationForm) return;
    if (!translationForm.title.trim()) {
      setTranslationError('Title is required for translation');
      return;
    }
    setTranslationSaving(true);
    setTranslationError('');
    try {
      const saved = await api.saveCampaignTranslation(campaign.id, {
        locale: translationForm.locale,
        title: translationForm.title.trim(),
        description: translationForm.description.trim() || null,
        milestone_titles: translationForm.milestone_titles || [],
      });
      setTranslations((prev) => {
        const filtered = prev.filter(
          (t) => t.locale !== translationForm.locale && t.language !== translationForm.locale
        );
        return [...filtered, saved];
      });
      setTranslationSuccess(`Translation for ${translationForm.locale.toUpperCase()} saved!`);
      setTranslationForm(null);
      if (currentLocale === translationForm.locale && onSaved) {
        onSaved();
      }
      setTimeout(() => setTranslationSuccess(''), 3000);
    } catch (err) {
      setTranslationError(err.message || 'Failed to save translation');
    } finally {
      setTranslationSaving(false);
    }
  }

  async function handleDeleteTranslation(locale) {
    if (!window.confirm(`Are you sure you want to delete the ${locale.toUpperCase()} translation?`))
      return;
    try {
      await api.deleteCampaignTranslation(campaign.id, locale);
      setTranslations((prev) => prev.filter((t) => t.locale !== locale && t.language !== locale));
      if (currentLocale === locale && onSaved) {
        onSaved();
      }
    } catch (err) {
      setTranslationError(err.message || 'Failed to delete translation');
    }
  }

  async function handleSubmit() {
    setError('');

    if (!formData.title.trim()) {
      setError('Title is required');
      return;
    }
    if (formData.title.length > 100) {
      setError('Title must be at most 100 characters');
      return;
    }
    if (formData.description.length > 1000) {
      setError('Description must be at most 1000 characters');
      return;
    }
    if (formData.deadline) {
      const deadlineDate = new Date(formData.deadline);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      deadlineDate.setHours(0, 0, 0, 0);
      if (deadlineDate < today) {
        setError('Deadline cannot be in the past');
        return;
      }
    }

    try {
      setLoading(true);
      const updates = {};
      if (formData.title !== campaign.title) updates.title = formData.title;
      if (formData.description !== campaign.description) updates.description = formData.description;
      if (formData.deadline !== (campaign.deadline ? campaign.deadline.split('T')[0] : '')) {
        updates.deadline = formData.deadline || null;
      }
      if (formData.target_amount !== String(campaign.target_amount)) {
        updates.target_amount = formData.target_amount;
      }

      if (Object.keys(updates).length === 0) {
        setError('No changes to save');
        setLoading(false);
        return;
      }

      const updated = await api.updateCampaign(campaign.id, updates, token);
      if (onSaved) onSaved(updated);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to update campaign');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-campaign-title"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        ref={modalRef}
        style={{
          background: 'var(--color-bg)',
          borderRadius: '12px',
          padding: '2rem',
          maxWidth: '500px',
          width: '90%',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="edit-campaign-title"
          style={{
            marginTop: 0,
            marginBottom: '1.5rem',
            fontSize: '1.5rem',
          }}
        >
          Edit Campaign
        </h2>

        {error && (
          <p
            style={{
              color: 'var(--color-status-error)',
              marginBottom: '1rem',
              padding: '0.75rem',
              background: 'var(--color-status-error-bg)',
              borderRadius: '6px',
            }}
          >
            {error}
          </p>
        )}

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.5rem',
            }}
          >
            Title
          </label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            maxLength={100}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--color-border-lightest)',
              borderRadius: '6px',
              fontSize: '1rem',
              boxSizing: 'border-box',
            }}
          />
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              margin: '0.25rem 0 0',
            }}
          >
            {formData.title.length}/100
          </p>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.5rem',
            }}
          >
            Description
          </label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            maxLength={1000}
            rows={5}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--color-border-lightest)',
              borderRadius: '6px',
              fontSize: '1rem',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              margin: '0.25rem 0 0',
            }}
          >
            {formData.description.length}/1000
          </p>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.5rem',
            }}
          >
            Deadline (optional)
          </label>
          <input
            type="date"
            value={formData.deadline}
            onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--color-border-lightest)',
              borderRadius: '6px',
              fontSize: '1rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.5rem',
            }}
          >
            Target Amount
          </label>
          <input
            type="number"
            value={formData.target_amount}
            onChange={(e) => setFormData({ ...formData, target_amount: e.target.value })}
            min="0"
            step="0.01"
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid var(--color-border-lightest)',
              borderRadius: '6px',
              fontSize: '1rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div
          style={{
            marginTop: '1.5rem',
            marginBottom: '1.5rem',
            borderTop: '1px solid var(--color-border-lightest)',
            paddingTop: '1.25rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.75rem',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Translations</h3>
            {translationsLoading && (
              <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                Loading...
              </span>
            )}
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              marginBottom: '1rem',
            }}
          >
            Add translated versions of your campaign content for international contributors. If a
            translation is not provided, the original content will be displayed.
          </p>

          {translationSuccess && (
            <div
              className="alert alert--success"
              style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
            >
              {translationSuccess}
            </div>
          )}
          {translationError && (
            <div
              className="alert alert--error"
              style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
            >
              {translationError}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
            {SUPPORTED_LOCALES.map((loc) => {
              const hasTranslation = translations.some(
                (t) => (t.locale || t.language) === loc.code
              );
              const isCurrentForm = translationForm?.locale === loc.code;
              return (
                <button
                  key={loc.code}
                  type="button"
                  className={isCurrentForm ? 'btn-primary' : 'btn-secondary'}
                  style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
                  onClick={() => handleStartAddTranslation(loc.code)}
                >
                  {hasTranslation ? `✓ Edit ${loc.label}` : `+ Add Translation (${loc.label})`}
                </button>
              );
            })}
          </div>

          {translationForm && (
            <div
              style={{
                background: 'var(--color-surface, #f9fafb)',
                border: '1px solid var(--color-border-lightest, #e5e7eb)',
                borderRadius: '8px',
                padding: '1rem',
                marginBottom: '1rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>
                  Editing{' '}
                  {SUPPORTED_LOCALES.find((l) => l.code === translationForm.locale)?.label ||
                    translationForm.locale.toUpperCase()}{' '}
                  Translation
                </h4>
                {translations.some((t) => (t.locale || t.language) === translationForm.locale) && (
                  <button
                    type="button"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-error, #ef4444)',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    onClick={() => handleDeleteTranslation(translationForm.locale)}
                  >
                    Delete translation
                  </button>
                )}
              </div>

              <div style={{ marginBottom: '0.75rem' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    marginBottom: '0.35rem',
                  }}
                >
                  Translated Title *
                </label>
                <input
                  type="text"
                  value={translationForm.title}
                  onChange={(e) =>
                    setTranslationForm({ ...translationForm, title: e.target.value })
                  }
                  placeholder="Title in selected language"
                  style={{
                    width: '100%',
                    padding: '0.6rem',
                    border: '1px solid var(--color-border-lightest)',
                    borderRadius: '6px',
                    fontSize: '0.9rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: '0.75rem' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    marginBottom: '0.35rem',
                  }}
                >
                  Translated Description (optional)
                </label>
                <textarea
                  value={translationForm.description}
                  onChange={(e) =>
                    setTranslationForm({ ...translationForm, description: e.target.value })
                  }
                  placeholder="Description in selected language"
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '0.6rem',
                    border: '1px solid var(--color-border-lightest)',
                    borderRadius: '6px',
                    fontSize: '0.9rem',
                    boxSizing: 'border-box',
                    resize: 'vertical',
                  }}
                />
              </div>

              {milestones && milestones.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      marginBottom: '0.35rem',
                    }}
                  >
                    Translated Milestone Titles (optional)
                  </label>
                  {milestones.map((m, idx) => (
                    <div key={m.id || idx} style={{ marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                        Milestone {idx + 1}: {m.title}
                      </span>
                      <input
                        type="text"
                        value={translationForm.milestone_titles?.[idx] || ''}
                        onChange={(e) => {
                          const newTitles = [...(translationForm.milestone_titles || [])];
                          newTitles[idx] = e.target.value;
                          setTranslationForm({
                            ...translationForm,
                            milestone_titles: newTitles,
                          });
                        }}
                        placeholder={`Translated title for "${m.title}"`}
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          border: '1px solid var(--color-border-lightest)',
                          borderRadius: '6px',
                          fontSize: '0.85rem',
                          boxSizing: 'border-box',
                          marginTop: '0.2rem',
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  justifyContent: 'flex-end',
                  marginTop: '0.75rem',
                }}
              >
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
                  onClick={() => setTranslationForm(null)}
                  disabled={translationSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
                  onClick={handleSaveTranslation}
                  disabled={translationSaving}
                >
                  {translationSaving ? 'Saving...' : 'Save Translation'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: '1rem',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={loading}
            style={{ opacity: loading ? 0.6 : 1 }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading}
            style={{ opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
