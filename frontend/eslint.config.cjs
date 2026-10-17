const js = require('@eslint/js');
const reactPlugin = require('eslint-plugin-react');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const noHardcodedStrings = require('./src/eslint-rules/no-hardcoded-strings.cjs');

module.exports = [
  // Ignore patterns
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },

  // Apply recommended rules to all JS/JSX files
  js.configs.recommended,

  // React flat config (includes plugin registration + recommended rules)
  reactPlugin.configs.flat.recommended,

  // React Hooks flat config
  {
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: reactHooksPlugin.configs.recommended.rules,
  },

  {
    files: ['**/*.{js,jsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'i18n': { rules: { 'no-hardcoded-strings': noHardcodedStrings } },
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Promise: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
        EventSource: 'readonly',
        MessageEvent: 'readonly',
        CustomEvent: 'readonly',
        ResizeObserver: 'readonly',
        confirm: 'readonly',
        crypto: 'readonly',
        alert: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        global: 'writable',
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'react/prop-types': 'warn',
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'i18n/no-hardcoded-strings': ['warn', {
        ignoredStrings: ['...', '–', '—', '×', '✕', '✓', '★', '☆', '⛓️', '📈', '⚡', '✨'],
        ignoredPatterns: ['^\\s*$', '^[A-Z]{2,}$', '^[0-9.]+$', '^[A-Z][a-z]+\\s[A-Z][a-z]+$']
      }],
    },
  },

  // Test files — add test globals
  {
    files: ['**/*.test.{js,jsx}', '**/*.spec.{js,jsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        before: 'readonly',
        beforeEach: 'readonly',
        after: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
        jest: 'readonly',
        global: 'writable',
      },
    },
  },
];
