const js = require('@eslint/js');

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
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      // #1236: Restrict parseFloat on monetary/token calculations to prevent precision loss.
      // Contributors should use toStroops/stroopsToDecimal from src/utils/stroops.js instead.
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'CallExpression[callee.name="parseFloat"]',
          message:
            'Avoid parseFloat for monetary calculations. Use toStroops or stroopsToDecimal from src/utils/stroops.js to prevent floating-point precision drift.',
        },
        {
          selector: 'CallExpression[callee.object.name="Number"][callee.property.name="parseFloat"]',
          message:
            'Avoid Number.parseFloat for monetary calculations. Use toStroops or stroopsToDecimal from src/utils/stroops.js to prevent floating-point precision drift.',
        },
      ],
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
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
