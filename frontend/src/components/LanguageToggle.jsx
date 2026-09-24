import { useState, useEffect } from 'react';
import { api } from '../services/api';

const LANGUAGE_LABELS = {
  en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
  it: 'Italiano', pt: 'Português', ru: 'Русский', ja: '日本語',
  ko: '한국어', zh: '中文', ar: 'العربية', hi: 'हिन्दी',
  bn: 'বাংলা', pa: 'ਪੰਜਾਬੀ', tr: 'Türkçe', nl: 'Nederlands',
  pl: 'Polski', sv: 'Svenska', da: 'Dansk', fi: 'Suomi',
};

export default function LanguageToggle({ campaignId, defaultLanguage, defaultTitle, defaultDescription, onTranslationChange }) {
  const [translations, setTranslations] = useState([]);
  const [activeLang, setActiveLang] = useState('en');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!campaignId) return;
    setLoading(true);
    api.getCampaignTranslations(campaignId)
      .then((res) => {
        const list = Array.isArray(res) ? res : (res?.data || []);
        setTranslations(list);
        // If translations exist for the browser language, use that
        const browserLang = navigator.language?.split('-')[0] || 'en';
        if (list.some((t) => (t.locale || t.language) === browserLang)) {
          setActiveLang(browserLang);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [campaignId]);

  const activeTranslation = translations.find((t) => (t.locale || t.language) === activeLang);

  const displayTitle = activeTranslation?.title || defaultTitle;
  const displayDescription = activeTranslation?.description || defaultDescription;

  // Notify parent of current translation state
  useEffect(() => {
    onTranslationChange?.({ title: displayTitle, description: displayDescription, language: activeLang });
  }, [displayTitle, displayDescription, activeLang, onTranslationChange]);

  if (translations.length === 0 && !loading) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {loading ? (
        <span className="text-xs text-gray-400">Loading translations...</span>
      ) : (
        <>
          <span className="text-xs text-gray-500 font-medium">🌐</span>
          {translations.map((t) => {
            const loc = t.locale || t.language;
            return (
              <button
                key={loc}
                onClick={() => setActiveLang(loc)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  activeLang === loc
                    ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-transparent'
                }`}
              >
                {LANGUAGE_LABELS[loc] || loc.toUpperCase()}
              </button>
            );
          })}
          {activeLang !== 'en' && defaultTitle && (
            <span className="text-xs text-gray-400 ml-1">
              Showing {LANGUAGE_LABELS[activeLang] || activeLang.toUpperCase()} translation
            </span>
          )}
        </>
      )}
    </div>
  );
}
