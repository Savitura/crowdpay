import SimpleMDE from 'react-simplemde-editor';

const SUPPORTED_LOCALES = [
  { code: 'fr', label: 'French (Français)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'de', label: 'German (Deutsch)' },
];
export default function CreateCampaignStepDetails({
  t,
  form,
  coverImageFile,
  coverImagePreview,
  isDragOverCover,
  translations,
  activeTranslationLocale,
  today,
  setField,
  setDescription,
  setTranslations,
  setActiveTranslationLocale,
  handleCoverImageChange,
  handleCoverImageDrop,
  setIsDragOverCover,
  setForm,
  error,
  onContinue,
  onBack,
}) {
  return (
    <>
      <>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '0.75rem',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-lightest)',
            borderRadius: '12px',
            padding: '1rem',
            marginBottom: '1rem',
          }}
        >
          <button
            type="button"
            onClick={onBack}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--color-accent)',
              padding: 0,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            ← Edit
          </button>
          <span style={{ fontWeight: 700 }}>{form.title || 'Untitled campaign'}</span>
          <span style={{ color: 'var(--color-text-muted)' }}>
            Goal: {form.target_amount || '—'} {form.asset_type || ''}
          </span>
        </div>
        <div className="form-stack">
          <label className="label-strong" htmlFor="cc-desc">
            {t('createCampaign.description')}{' '}
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
              {t('createCampaign.optional')}
            </span>
          </label>
          <SimpleMDE
            id="cc-desc"
            value={form.description}
            onChange={setDescription}
            options={{
              spellChecker: false,
              placeholder: t('createCampaign.descriptionPlaceholder'),
            }}
          />
        </div>

        <div className="form-stack" style={{ marginTop: '1rem' }}>
          <label className="label-strong" htmlFor="cc-cover">
            {t('createCampaign.coverImage')}{' '}
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
              {t('createCampaign.optional')}
            </span>
          </label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOverCover(true);
            }}
            onDragLeave={() => setIsDragOverCover(false)}
            onDrop={handleCoverImageDrop}
            style={{
              border: `2px dashed ${isDragOverCover ? 'var(--color-accent)' : 'var(--color-border-lightest)'}`,
              borderRadius: '12px',
              padding: '0.9rem',
              background: isDragOverCover ? 'var(--color-accent-lightest)' : 'var(--color-surface)',
            }}
          >
            <input
              id="cc-cover"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleCoverImageChange}
            />
            <p
              style={{
                marginTop: '0.45rem',
                marginBottom: 0,
                color: 'var(--color-text-hint)',
                fontSize: '0.8rem',
              }}
            >
              {t('createCampaign.coverImageHelp')}
            </p>
          </div>
          {coverImagePreview && (
            <img
              src={coverImagePreview}
              alt="Cover preview"
              style={{
                marginTop: '0.75rem',
                width: '100%',
                borderRadius: '12px',
                maxHeight: '220px',
                objectFit: 'cover',
              }}
            />
          )}
        </div>

        <div className="form-stack" style={{ marginTop: '1rem' }}>
          <label className="label-strong" htmlFor="cc-deadline">
            {t('createCampaign.deadline')}{' '}
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
              {t('createCampaign.optional')}
            </span>
          </label>
          <input
            id="cc-deadline"
            type="date"
            min={today}
            value={form.deadline}
            onChange={setField('deadline')}
          />
        </div>

        <div
          className="form-stack"
          style={{
            marginTop: '1.25rem',
            flexDirection: 'row',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <input
            id="cc-show-backers"
            type="checkbox"
            style={{ width: 'auto', margin: 0 }}
            checked={form.show_backer_amounts}
            onChange={(e) => setForm((f) => ({ ...f, show_backer_amounts: e.target.checked }))}
          />
          <label
            htmlFor="cc-show-backers"
            style={{ fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}
          >
            {t('createCampaign.showAmounts')}
          </label>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', marginTop: '0.35rem' }}>
          {t('createCampaign.showAmountsHelp')}
        </p>

        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
            Contribution limits (optional)
          </summary>
          <div
            style={{
              marginTop: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div className="form-stack">
              <label htmlFor="cc-min">Minimum per contribution ({form.asset_type})</label>
              <input
                id="cc-min"
                type="number"
                min="0"
                step="any"
                value={form.min_contribution}
                onChange={setField('min_contribution')}
                placeholder="No minimum"
              />
            </div>
            <div className="form-stack">
              <label htmlFor="cc-max">Maximum per contribution ({form.asset_type})</label>
              <input
                id="cc-max"
                type="number"
                min="0"
                step="any"
                value={form.max_contribution}
                onChange={setField('max_contribution')}
                placeholder="No maximum"
              />
            </div>
            <div className="form-stack">
              <label htmlFor="cc-maxuser">Per-contributor cap ({form.asset_type})</label>
              <input
                id="cc-maxuser"
                type="number"
                min="0"
                step="any"
                value={form.max_per_user}
                onChange={setField('max_per_user')}
                placeholder="No cap"
              />
            </div>
          </div>
        </details>

        <div
          style={{
            marginTop: '1.5rem',
            borderTop: '1px solid var(--color-border-lightest)',
            paddingTop: '1.25rem',
          }}
        >
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.35rem' }}>
            Translations (Optional)
          </h3>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              marginBottom: '0.75rem',
            }}
          >
            Provide translated versions of your campaign for international contributors.
          </p>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginBottom: '0.75rem',
            }}
          >
            {SUPPORTED_LOCALES.map((loc) => {
              const hasTranslation = Boolean(translations[loc.code]?.title);
              const isActive = activeTranslationLocale === loc.code;
              return (
                <button
                  key={loc.code}
                  type="button"
                  className={isActive ? 'btn-primary' : 'btn-secondary'}
                  style={{ fontSize: '0.85rem', padding: '0.35rem 0.65rem' }}
                  onClick={() => setActiveTranslationLocale(isActive ? null : loc.code)}
                >
                  {hasTranslation ? `✓ Edit ${loc.label}` : `+ Add Translation (${loc.label})`}
                </button>
              );
            })}
          </div>

          {activeTranslationLocale && (
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
                  marginBottom: '0.5rem',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                  {SUPPORTED_LOCALES.find((l) => l.code === activeTranslationLocale)?.label}{' '}
                  Translation
                </span>
                {translations[activeTranslationLocale]?.title && (
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
                    onClick={() => {
                      const next = { ...translations };
                      delete next[activeTranslationLocale];
                      setTranslations(next);
                      setActiveTranslationLocale(null);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="form-stack" style={{ marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Translated Title *</label>
                <input
                  type="text"
                  value={translations[activeTranslationLocale]?.title || ''}
                  onChange={(e) =>
                    setTranslations((prev) => ({
                      ...prev,
                      [activeTranslationLocale]: {
                        ...prev[activeTranslationLocale],
                        title: e.target.value,
                      },
                    }))
                  }
                  placeholder={`Title in ${SUPPORTED_LOCALES.find((l) => l.code === activeTranslationLocale)?.label}`}
                />
              </div>
              <div className="form-stack" style={{ marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                  Translated Description (optional)
                </label>
                <textarea
                  value={translations[activeTranslationLocale]?.description || ''}
                  onChange={(e) =>
                    setTranslations((prev) => ({
                      ...prev,
                      [activeTranslationLocale]: {
                        ...prev[activeTranslationLocale],
                        description: e.target.value,
                      },
                    }))
                  }
                  rows={3}
                  placeholder={`Description in ${SUPPORTED_LOCALES.find((l) => l.code === activeTranslationLocale)?.label}`}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    border: '1px solid var(--color-border-lightest)',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    boxSizing: 'border-box',
                    resize: 'vertical',
                  }}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}
                onClick={() => setActiveTranslationLocale(null)}
              >
                Done
              </button>
            </div>
          )}
        </div>

        {error && (
          <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
            {error}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            marginTop: '1.25rem',
          }}
        >
          <button
            type="button"
            className="btn-primary"
            style={{ width: '100%' }}
            onClick={onContinue}
          >
            {t('createCampaign.continueToMilestones')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ width: '100%' }}
            onClick={onBack}
          >
            {t('createCampaign.back')}
          </button>
        </div>
      </>
    </>
  );
}
