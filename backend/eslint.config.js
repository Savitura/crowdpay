// eslint.config.js — CommonJS flat config (no "type":"module" in package.json)
module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'readonly', exports: 'readonly', __dirname: 'readonly',
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly', setImmediate: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  { ignores: ['node_modules/', 'dist/'] },
];
