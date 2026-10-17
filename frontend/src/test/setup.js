import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Provide a simple in‑memory localStorage mock for test environment
if (typeof global.localStorage === 'undefined') {
  const _storage = {};
  global.localStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(_storage, key) ? _storage[key] : null;
    },
    setItem(key, value) {
      _storage[key] = String(value);
    },
    removeItem(key) {
      delete _storage[key];
    },
    clear() {
      Object.keys(_storage).forEach((k) => delete _storage[k]);
    },
  };
}
// Ensure window.localStorage mirrors the same mock when JSDOM provides a window object
if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
  window.localStorage = global.localStorage;
}
import en from '../locales/en.json';
import fr from '../locales/fr.json';
import { describe, it, expect } from 'vitest';

const locales = { en, fr };

function getAllKeys(obj, prefix = '') {
  return Object.keys(obj).reduce((res, k) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      return [...res, ...getAllKeys(obj[k], path)];
    }
    return [...res, path];
  }, []);
}

describe('i18n key parity check', () => {
  it('ensures fr.json defines every key present in en.json', () => {
    const enKeys = getAllKeys(en);
    const frKeys = new Set(getAllKeys(fr));
    const missing = enKeys.filter((key) => !frKeys.has(key));
    expect(missing, `Missing translation keys in fr.json: ${missing.join(', ')}`).toEqual([]);
  });
});

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = function () {
    return {
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  };
}

function lookup(obj, path) {
  return path
    .split('.')
    .reduce((o, k) => (o && o[k] !== null && o[k] !== undefined ? o[k] : undefined), obj);
}

let currentLanguage = 'en';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const langDict = locales[currentLanguage] || en;
      const val = lookup(langDict, key) ?? lookup(en, key);
      if (val === null || val === undefined) return key;
      if (typeof val !== 'string') return key;
      if (opts === undefined || opts === null) return val;
      return Object.entries(opts).reduce(
        (s, [k, v]) => s.replace(new RegExp(`{{${k}}}`, 'g'), v),
        val
      );
    },
    i18n: {
      get language() {
        return currentLanguage;
      },
      set language(l) {
        currentLanguage = l;
      },
      get resolvedLanguage() {
        return currentLanguage;
      },
      changeLanguage: vi.fn(async (lng) => {
        currentLanguage = lng;
      }),
    },
  }),
  Trans: ({ children }) => children,
}));
