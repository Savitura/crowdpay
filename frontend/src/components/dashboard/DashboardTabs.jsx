import { useTranslation } from 'react-i18next';

export default function DashboardTabs({ tabs, activeTab, onTabChange }) {
  const { t } = useTranslation();

  return (
    <>
      <div
        role="tablist"
        aria-label={t('dashboard.sectionsLabel')}
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.25rem',
          borderBottom: '1px solid var(--color-border)',
          paddingBottom: '0.5rem',
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: activeTab === tab.id ? 'var(--color-accent)' : 'transparent',
              color: activeTab === tab.id ? 'var(--color-bg)' : 'var(--color-text-secondary)',
            }}
          >
            {tab.label ? tab.label : t(tab.labelKey)}
          </button>
        ))}
      </div>
    </>
  );
}
