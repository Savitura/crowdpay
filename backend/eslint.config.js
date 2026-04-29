import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  { ignores: ['node_modules/', 'dist/'] },
];
