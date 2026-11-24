#!/usr/bin/env node

/**
 * Verifies that all frontend locale JSON files in frontend/src/locales/
 * share identical key sets and i18next interpolation tokens.
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.resolve(__dirname, '..', 'frontend', 'src', 'locales');
const BASE_LOCALE = 'en';
const INTERPOLATION_REGEX = /\{\{\s*([^},\s]+)(?:,[^}]*)?\s*\}\}/g;

function flattenKeys(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenKeys(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function extractInterpolationTokens(value) {
  if (typeof value !== 'string') {
    return [];
  }
  const tokens = [];
  let match;
  INTERPOLATION_REGEX.lastIndex = 0;
  while ((match = INTERPOLATION_REGEX.exec(value)) !== null) {
    tokens.push(match[1]);
  }
  return tokens.sort();
}

function checkLocaleParity(localesDir = LOCALES_DIR, baseLocale = BASE_LOCALE) {
  const files = fs
    .readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  const baseFile = `${baseLocale}.json`;
  if (!files.includes(baseFile)) {
    throw new Error(`Base locale file not found: ${path.join(localesDir, baseFile)}`);
  }

  const baseData = JSON.parse(fs.readFileSync(path.join(localesDir, baseFile), 'utf8'));
  const baseFlat = flattenKeys(baseData);
  const baseKeys = new Set(Object.keys(baseFlat));

  const errors = [];
  const checkedLocales = [];

  for (const file of files) {
    const locale = path.basename(file, '.json');
    checkedLocales.push(locale);
    if (locale === baseLocale) {
      continue;
    }

    const localeData = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
    const localeFlat = flattenKeys(localeData);
    const localeKeys = new Set(Object.keys(localeFlat));

    const missingKeys = [...baseKeys].filter((k) => !localeKeys.has(k)).sort();
    const extraKeys = [...localeKeys].filter((k) => !baseKeys.has(k)).sort();

    if (missingKeys.length > 0) {
      errors.push(`[${locale}] Missing ${missingKeys.length} key(s): ${missingKeys.join(', ')}`);
    }
    if (extraKeys.length > 0) {
      errors.push(`[${locale}] Extra ${extraKeys.length} key(s): ${extraKeys.join(', ')}`);
    }

    for (const key of baseKeys) {
      if (!localeKeys.has(key)) {
        continue;
      }
      const baseTokens = extractInterpolationTokens(baseFlat[key]);
      const localeTokens = extractInterpolationTokens(localeFlat[key]);
      if (baseTokens.join('|') !== localeTokens.join('|')) {
        errors.push(
          `[${locale}] Interpolation token mismatch for "${key}": expected [${baseTokens.join(', ')}] (${baseLocale}), got [${localeTokens.join(', ')}] (${locale})`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedLocales,
    keyCount: baseKeys.size,
    errors,
  };
}

if (require.main === module) {
  const result = checkLocaleParity();
  if (!result.ok) {
    console.error('i18n locale parity check failed:');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log(
    `i18n locale parity check passed (${result.checkedLocales.join(', ')}; ${result.keyCount} keys).`,
  );
}

module.exports = {
  checkLocaleParity,
  extractInterpolationTokens,
  flattenKeys,
};
