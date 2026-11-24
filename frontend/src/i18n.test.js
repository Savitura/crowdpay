import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('react-i18next');

async function loadI18n() {
  const i18n = (await import('./i18n')).default;
  if (!i18n.isInitialized) {
    await new Promise((resolve) => i18n.on('initialized', resolve));
  }
  return i18n;
}

describe('i18n lazy locale loading', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  it('does not load the fr bundle when the resolved language is en', async () => {
    window.localStorage.setItem('i18nextLng', 'en');
    const i18n = await loadI18n();

    expect(i18n.resolvedLanguage).toBe('en');
    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(false);
    expect(i18n.t('common.cancel')).toBe('Cancel');
  });

  it('lazily loads the fr bundle when switching languages', async () => {
    window.localStorage.setItem('i18nextLng', 'en');
    const i18n = await loadI18n();

    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(false);

    await i18n.changeLanguage('fr');

    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(true);
    expect(i18n.t('common.cancel')).toBe('Annuler');
  });

  it('falls back gracefully for an unsupported language', async () => {
    window.localStorage.setItem('i18nextLng', 'en');
    const i18n = await loadI18n();

    await i18n.changeLanguage('de');

    expect(i18n.t('common.cancel')).toBe('Cancel');
  });
});

describe('i18n locale key and interpolation parity', () => {
  it('ensures all locale files share identical key sets and interpolation tokens', async () => {
    const { checkLocaleParity } = await import('../../scripts/check-i18n-parity.js');
    const result = checkLocaleParity();

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
