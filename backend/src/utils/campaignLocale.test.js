const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCampaignLanguage, SUPPORTED_LANGUAGES } = require('./campaignLocale');

test('resolves a regional locale to its supported language', () => {
  assert.equal(resolveCampaignLanguage('fr-CA'), 'fr');
  assert.equal(resolveCampaignLanguage('pt-BR'), 'pt');
  assert.equal(resolveCampaignLanguage('es-419'), 'es');
});

test('accepts underscore separators and upper case', () => {
  assert.equal(resolveCampaignLanguage('FR_ca'), 'fr');
  assert.equal(resolveCampaignLanguage('ZH-Hant-TW'), 'zh');
});

test('trims surrounding whitespace', () => {
  assert.equal(resolveCampaignLanguage('  de-AT  '), 'de');
});

test('falls back to null for unsupported or malformed input', () => {
  assert.equal(resolveCampaignLanguage('xx-YY'), null);
  assert.equal(resolveCampaignLanguage(''), null);
  assert.equal(resolveCampaignLanguage(null), null);
  assert.equal(resolveCampaignLanguage(undefined), null);
  assert.equal(resolveCampaignLanguage(42), null);
});

test('exposes the supported language set', () => {
  assert.ok(SUPPORTED_LANGUAGES.has('en'));
  assert.ok(SUPPORTED_LANGUAGES.has('sw') === false, 'unsupported languages stay out of the set');
});
