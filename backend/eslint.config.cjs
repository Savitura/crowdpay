const js = require('@eslint/js');

const NO_PARSE_FLOAT_MESSAGE =
  'Avoid parseFloat() on monetary amounts — binary floating point drifts on 7-decimal Stellar amounts. Use exact decimal/stroop helpers from backend/src/utils/stroops.js (toStroops, fromStroops, compareAmounts, percentToBps, divideAmounts) instead.';

const NO_PARSE_FLOAT_SELECTORS = [
  {
    selector: 'CallExpression[callee.name="parseFloat"]',
    message: NO_PARSE_FLOAT_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.type="MemberExpression"][callee.property.name="parseFloat"]',
    message: NO_PARSE_FLOAT_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.type="MemberExpression"][callee.property.value="parseFloat"]',
    message: NO_PARSE_FLOAT_MESSAGE,
  },
  {
    selector:
      'Identifier[name="parseFloat"]:not(CallExpression > .callee):not(MemberExpression > .property)',
    message: NO_PARSE_FLOAT_MESSAGE,
  },
];

module.exports = [
  // Ignore patterns
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      // campaigns.test.js has pre-existing structural corruption (interleaved test blocks
      // from a bad merge) that causes parse errors. Excluded until the file is repaired.
      'src/routes/campaigns.test.js',
    ],
  },

  // Apply recommended rules to all JS files
  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        console: 'readonly',
        // Node 18+ built-ins (available globally without import)
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-restricted-syntax': ['error', ...NO_PARSE_FLOAT_SELECTORS],
    },
  },

  // Test files — relax some rules
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        beforeEach: 'readonly',
        after: 'readonly',
        afterEach: 'readonly',
        expect: 'readonly',
        jest: 'readonly',
      },
    },
  },

  // stroops.test.js intentionally calls parseFloat() to demonstrate binary float drift.
  {
    files: ['src/utils/stroops.test.js'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Legacy files with pre-existing parseFloat() calls pending migration to src/utils/stroops.js.
  // Downgraded to 'warn' so CI passes while preventing any new or already-migrated files from
  // reintroducing parseFloat(). Remove each file as it is migrated to stroops.js.
  {
    files: [
      'src/middleware/validation.js',
      'src/routes/admin.js',
      'src/routes/campaigns/crud.js',
      'src/routes/campaigns/refunds.js',
      'src/routes/contributions.test.js',
      'src/routes/disputes.js',
      'src/routes/rates.js',
      'src/services/contributionDiagnostics.js',
      'src/services/contributionPolicy.js',
      'src/services/contributionService.js',
      'src/services/contributorIdentityService.js',
      'src/services/exchangeRateService.js',
      'src/services/governance.js',
      'src/services/ops/healthCollector.js',
      'src/services/ops/healthCollector.test.js',
      'src/services/poolQueries.js',
      'src/services/poolQueries.test.js',
      'src/services/reconciliation.js',
      'src/services/referralService.js',
      'src/services/sponsorMatchingService.js',
      'src/services/stellarService.js',
      'src/services/stellarService.referral.test.js',
    ],
    rules: {
      'no-restricted-syntax': ['warn', ...NO_PARSE_FLOAT_SELECTORS],
    },
  },
];
