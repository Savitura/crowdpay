const SUPPORTED_LANGUAGES = new Set([
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ru',
  'ja',
  'ko',
  'zh',
  'ar',
  'hi',
  'bn',
  'pa',
  'tr',
  'nl',
  'pl',
  'sv',
  'da',
  'fi',
]);

/** Resolve a BCP 47 locale to a supported campaign language (for example, fr-CA to fr). */
function resolveCampaignLanguage(locale) {
  if (typeof locale !== 'string') return null;
  const language = locale.trim().replace(/_/g, '-').split('-')[0].toLowerCase();
  return SUPPORTED_LANGUAGES.has(language) ? language : null;
}

module.exports = { resolveCampaignLanguage, SUPPORTED_LANGUAGES };
